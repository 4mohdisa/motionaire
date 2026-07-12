use std::collections::HashMap;

use super::decoder::Decoder;
use super::keyframes::resolve_layer;
use super::types::{CropCfg, SyncProject};

// Clamp crop fractions to something drawable (each edge <45%, pairs <90%).
fn sane_crop(c: &CropCfg) -> (f32, f32, f32, f32) {
    let cl = (c.l as f32).clamp(0.0, 0.45);
    let ct = (c.t as f32).clamp(0.0, 0.45);
    let cr = (c.r as f32).clamp(0.0, 0.45);
    let cb = (c.b as f32).clamp(0.0, 0.45);
    (cl, ct, cr, cb)
}

// Headless wgpu compositor: decoded RGBA frames → per-layer textures → one render
// pass drawing quads back-to-front by z with transform + rounded-rect SDF + opacity
// (CONTEXT.md §3.2 feature set) → offscreen target → CPU readback.

const SHADER: &str = r#"
struct LayerU {
  rot_t:   vec4<f32>, // cos, sin, tx, ty            (canvas px, center origin, y-down)
  half_ro: vec4<f32>, // half_w_scaled, half_h_scaled, corner_radius, opacity
  uv_rect: vec4<f32>, // u0, v0, u1, v1 — crop window in texture space
  shcolor: vec4<f32>, // shadow rgba (straight alpha); unused for content pass
  canvas:  vec4<f32>, // canvas_w, canvas_h, mode (0 content / 1 shadow), blur px
};

@group(0) @binding(0) var<uniform> u: LayerU;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) local: vec2<f32>, // scaled local px, pre-rotation
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var units = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0),  vec2(1.0, -1.0), vec2(1.0, 1.0),
  );
  // Shadow pass expands the quad so the blur falloff has room to render.
  let expand = select(0.0, u.canvas.w + 1.0, u.canvas.z > 0.5);
  let unit = units[vi];
  let half = u.half_ro.xy + vec2(expand, expand);
  let p = unit * half;
  let rp = vec2(
    p.x * u.rot_t.x - p.y * u.rot_t.y,
    p.x * u.rot_t.y + p.y * u.rot_t.x,
  );
  let cpos = rp + u.rot_t.zw;
  var o: VOut;
  o.pos = vec4(cpos.x * 2.0 / u.canvas.x, -cpos.y * 2.0 / u.canvas.y, 0.0, 1.0);
  let tuv = unit * 0.5 + vec2(0.5, 0.5);
  o.uv = mix(u.uv_rect.xy, u.uv_rect.zw, tuv);
  o.local = p;
  return o;
}

fn rounded_sd(p: vec2<f32>, half: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - half + vec2(r, r);
  return length(max(q, vec2(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let half = u.half_ro.xy;
  let r = clamp(u.half_ro.z, 0.0, min(half.x, half.y));
  let sd = rounded_sd(in.local, half, r);
  if (u.canvas.z > 0.5) {
    // Shadow: soft falloff across the blur width around the (spread-grown) rect.
    // Analytic SDF approximation of a gaussian shadow — not a true blur of
    // content, which a solid video rect doesn't need.
    let blur = max(u.canvas.w, 0.5);
    let a = (1.0 - smoothstep(-blur * 0.5, blur * 0.5 + 0.75, sd)) * u.shcolor.a;
    return vec4(u.shcolor.rgb, a * u.half_ro.w);
  }
  let aa = 1.0 - smoothstep(-0.75, 0.75, sd);
  let c = textureSample(tex, samp, in.uv);
  return vec4(c.rgb, c.a * aa * u.half_ro.w);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniform {
    rot_t: [f32; 4],
    half_ro: [f32; 4],
    uv_rect: [f32; 4],
    shcolor: [f32; 4],
    canvas: [f32; 4],
}

struct LayerSlot {
    decoder: Decoder,
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    // Second uniform+bind group for the shadow pre-pass.
    bind_group_shadow: wgpu::BindGroup,
    uniform_shadow: wgpu::Buffer,
}

pub struct GpuCompositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    target: wgpu::Texture,
    readback: wgpu::Buffer,
    pub out_w: u32,
    pub out_h: u32,
    padded_bpr: u32,
    slots: HashMap<String, LayerSlot>, // keyed by media path
}

fn align_up(v: u32, a: u32) -> u32 {
    v.div_ceil(a) * a
}

impl GpuCompositor {
    // out_h: preview render height — 720 draft (default) or full canvas height.
    pub fn new(canvas_w: u32, canvas_h: u32, out_h: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .ok_or("no wgpu adapter")?;
        log::info!("compositor adapter: {:?}", adapter.get_info());
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("compositor"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::default(),
            },
            None,
        ))
        .map_err(|e| format!("request_device: {e}"))?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let out_h = out_h.clamp(144, canvas_h.max(144));
        let out_w = (canvas_w as f64 * out_h as f64 / canvas_h as f64).round() as u32 & !1;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("composite-target"),
            size: wgpu::Extent3d { width: out_w, height: out_h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let padded_bpr = align_up(out_w * 4, 256);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (padded_bpr * out_h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            bgl,
            sampler,
            target,
            readback,
            out_w,
            out_h,
            padded_bpr,
            slots: HashMap::new(),
        })
    }

    fn slot_for(&mut self, path: &str) -> Result<(), String> {
        if self.slots.contains_key(path) {
            return Ok(());
        }
        let decoder = Decoder::new(path)?;
        let (w, h) = (decoder.info.width, decoder.info.height);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("layer"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mk_uniform = |label: &str| {
            self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: std::mem::size_of::<LayerUniform>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let uniform = mk_uniform("layer-uniform");
        let uniform_shadow = mk_uniform("layer-uniform-shadow");
        let view = texture.create_view(&Default::default());
        let mk_bg = |buf: &wgpu::Buffer| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            })
        };
        let bind_group = mk_bg(&uniform);
        let bind_group_shadow = mk_bg(&uniform_shadow);
        self.slots.insert(
            path.to_string(),
            LayerSlot { decoder, texture, bind_group, uniform, bind_group_shadow, uniform_shadow },
        );
        Ok(())
    }

    // "#RRGGBB" or "#RRGGBBAA" → linear-ish rgba floats (target is non-srgb).
    fn parse_rgba(hex: &str, default_alpha: f32) -> [f32; 4] {
        let h = hex.trim_start_matches('#');
        let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
        let a = if h.len() >= 8 { p(6) as f32 / 255.0 } else { default_alpha };
        [p(0) as f32 / 255.0, p(2) as f32 / 255.0, p(4) as f32 / 255.0, a]
    }

    fn parse_bg(hex: &str) -> wgpu::Color {
        let h = hex.trim_start_matches('#');
        let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
        let srgb_to_linear = |c: u8| {
            let f = c as f64 / 255.0;
            if f <= 0.04045 { f / 12.92 } else { ((f + 0.055) / 1.055).powf(2.4) }
        };
        // Target is Rgba8Unorm (non-srgb view), so values pass through untransformed.
        let _ = srgb_to_linear;
        wgpu::Color {
            r: p(0) as f64 / 255.0,
            g: p(2) as f64 / 255.0,
            b: p(4) as f64 / 255.0,
            a: 1.0,
        }
    }

    // Composite the project at timeline time `t` and return tightly-packed RGBA.
    pub fn render_at(&mut self, project: &SyncProject, t: f64) -> Result<Vec<u8>, String> {
        let cw = project.canvas.width as f32;
        let ch = project.canvas.height as f32;
        // Canvas-space math throughout; the viewport scale falls out of NDC mapping.

        // Back-to-front by z; within a z (track), outgoing before incoming so
        // cross transitions blend incoming over outgoing. A layer stays
        // drawable through its trailing handle while the next clip's cross
        // transition runs (canon: cross transitions on the incoming in-edge).
        let fps = project.canvas.fps.max(1.0);
        let mut active: Vec<&super::types::Layer> = project
            .layers
            .iter()
            .filter(|l| {
                let tail = super::types::transition_tail(&project.layers, l, fps);
                l.start <= t && t < l.end() + tail
            })
            .collect();
        active.sort_by(|a, b| {
            a.z.cmp(&b.z)
                .then(a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal))
        });

        // Upload decoded frames + uniforms before encoding the pass.
        let mut draws: Vec<(String, bool)> = Vec::new(); // (path, has_shadow)
        for layer in &active {
            if self.slot_for(&layer.media_path).is_err() {
                continue; // unreadable media: skip layer, keep compositing the rest
            }
            let src_t = layer.source_time(t);
            let slot = self.slots.get_mut(&layer.media_path).unwrap();
            let (mw, mh) = (slot.decoder.info.width, slot.decoder.info.height);
            if let Some(frame) = slot.decoder.frame_at(src_t) {
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &slot.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    frame,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(mw * 4),
                        rows_per_image: Some(mh),
                    },
                    wgpu::Extent3d { width: mw, height: mh, depth_or_array_layers: 1 },
                );
            } else {
                continue;
            }

            let mut r = resolve_layer(layer, t);

            // --- Transitions (session 7, Part 3) ---
            // In-edge window [start, start+d): dissolve/fade modulate alpha,
            // slide enters from the right, wipe reveals left→right via the
            // crop machinery. Out-edge: fade (and, degraded, any cross type
            // without a partner) modulates alpha toward the end.
            let mut wipe_reveal: f32 = 1.0;
            if let Some(tr) = &layer.transitions.in_ {
                let d = tr.duration.max(1e-6);
                if t < layer.start + d {
                    let p = (((t - layer.start) / d).clamp(0.0, 1.0)) as f32;
                    match tr.kind.as_str() {
                        "dissolve" | "fade" => r.opacity *= p,
                        "slide" => r.x += (1.0 - p) * cw,
                        "wipe" => wipe_reveal = p,
                        _ => {}
                    }
                }
            }
            if let Some(tr) = &layer.transitions.out {
                let d = tr.duration.max(1e-6);
                let end = layer.end();
                if t > end - d {
                    let q = (((end - t) / d).clamp(0.0, 1.0)) as f32;
                    // Cross types on an out-edge degrade to a fade (logged canon).
                    r.opacity *= q;
                }
            }

            // object-fit: contain into the canvas, then keyframed transform.
            let fit = (cw / mw as f32).min(ch / mh as f32);
            let (dw, dh) = (mw as f32 * fit * r.scale, mh as f32 * fit * r.scale);

            // Crop cuts pixels away from the fitted rect (Premiere semantics):
            // the visible sub-rect keeps its on-canvas position; its center
            // shifts by the crop asymmetry, rotating with the layer.
            let (cl, ct2, mut cr2, cb) = sane_crop(&r.crop);
            if wipe_reveal < 1.0 {
                // Reveal fraction of the (user-cropped) visible width.
                cr2 = (cr2 + (1.0 - wipe_reveal) * (1.0 - cl - cr2)).min(0.999);
            }
            let half_w = dw * (1.0 - cl - cr2) * 0.5;
            let half_h = dh * (1.0 - ct2 - cb) * 0.5;
            let off = ((cl - cr2) * 0.5 * dw, (ct2 - cb) * 0.5 * dh);
            let theta = r.rotation_deg.to_radians();
            let (cos, sin) = (theta.cos(), theta.sin());
            let tx = r.x + off.0 * cos - off.1 * sin;
            let ty = r.y + off.0 * sin + off.1 * cos;

            let content = LayerUniform {
                rot_t: [cos, sin, tx, ty],
                half_ro: [half_w, half_h, r.corner_radius, r.opacity.clamp(0.0, 1.0)],
                uv_rect: [cl, ct2, 1.0 - cr2, 1.0 - cb],
                shcolor: [0.0; 4],
                canvas: [cw, ch, 0.0, 0.0],
            };
            self.queue.write_buffer(&slot.uniform, 0, bytemuck::bytes_of(&content));

            let mut has_shadow = false;
            if let Some(sh) = &r.shadow {
                // 6-digit colors get a conventional 0.5 alpha; #RRGGBBAA overrides.
                let color = Self::parse_rgba(&sh.color, 0.5);
                if color[3] > 0.0 && r.opacity > 0.0 {
                    has_shadow = true;
                    let spread = sh.spread as f32;
                    let shadow_u = LayerUniform {
                        // Offset in canvas space (fixed light source, doesn't rotate).
                        rot_t: [cos, sin, tx + sh.x as f32, ty + sh.y as f32],
                        half_ro: [
                            half_w + spread,
                            half_h + spread,
                            (r.corner_radius + spread).max(0.0),
                            r.opacity.clamp(0.0, 1.0),
                        ],
                        uv_rect: [0.0, 0.0, 1.0, 1.0],
                        shcolor: color,
                        canvas: [cw, ch, 1.0, (sh.blur as f32).max(0.0)],
                    };
                    self.queue.write_buffer(&slot.uniform_shadow, 0, bytemuck::bytes_of(&shadow_u));
                }
            }
            draws.push((layer.media_path.clone(), has_shadow));
        }

        let view = self.target.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(Self::parse_bg(&project.canvas.background)),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            for (path, has_shadow) in &draws {
                let slot = &self.slots[path];
                if *has_shadow {
                    pass.set_bind_group(0, &slot.bind_group_shadow, &[]);
                    pass.draw(0..6, 0..1);
                }
                pass.set_bind_group(0, &slot.bind_group, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bpr),
                    rows_per_image: Some(self.out_h),
                },
            },
            wgpu::Extent3d { width: self.out_w, height: self.out_h, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);

        let slice = self.readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("map_async: {e:?}"))?;

        let tight_bpr = (self.out_w * 4) as usize;
        let mut out = vec![0u8; tight_bpr * self.out_h as usize];
        {
            let data = slice.get_mapped_range();
            for row in 0..self.out_h as usize {
                let src = row * self.padded_bpr as usize;
                out[row * tight_bpr..(row + 1) * tight_bpr]
                    .copy_from_slice(&data[src..src + tight_bpr]);
            }
        }
        self.readback.unmap();
        Ok(out)
    }

    pub fn dump_png(&mut self, project: &SyncProject, t: f64, path: &std::path::Path) -> Result<(), String> {
        let pixels = self.render_at(project, t)?;
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), self.out_w, self.out_h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&pixels).map_err(|e| e.to_string())?;
        Ok(())
    }
}
