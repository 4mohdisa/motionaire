use std::collections::HashMap;

use super::decoder::Decoder;
use super::keyframes::resolve_layer;
use super::types::SyncProject;

// Headless wgpu compositor: decoded RGBA frames → per-layer textures → one render
// pass drawing quads back-to-front by z with transform + rounded-rect SDF + opacity
// (CONTEXT.md §3.2 feature set) → offscreen target → CPU readback.

const SHADER: &str = r#"
struct LayerU {
  rot_t:   vec4<f32>, // cos, sin, tx, ty            (canvas px, center origin, y-down)
  half_ro: vec4<f32>, // half_w_scaled, half_h_scaled, corner_radius, opacity
  canvas:  vec4<f32>, // canvas_w, canvas_h, _, _
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
  let unit = units[vi];
  let p = unit * u.half_ro.xy;
  let rp = vec2(
    p.x * u.rot_t.x - p.y * u.rot_t.y,
    p.x * u.rot_t.y + p.y * u.rot_t.x,
  );
  let cpos = rp + u.rot_t.zw;
  var o: VOut;
  o.pos = vec4(cpos.x * 2.0 / u.canvas.x, -cpos.y * 2.0 / u.canvas.y, 0.0, 1.0);
  o.uv = unit * 0.5 + vec2(0.5, 0.5);
  o.local = p;
  return o;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let half = u.half_ro.xy;
  let r = clamp(u.half_ro.z, 0.0, min(half.x, half.y));
  let q = abs(in.local) - half + vec2(r, r);
  let sd = length(max(q, vec2(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
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
    canvas: [f32; 4],
}

struct LayerSlot {
    decoder: Decoder,
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
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

// Fixed 720p-class output for the spike: enough to judge quality and measure
// honestly, cheap enough for readback + IPC. Width follows canvas aspect.
const OUT_H: u32 = 720;

fn align_up(v: u32, a: u32) -> u32 {
    v.div_ceil(a) * a
}

impl GpuCompositor {
    pub fn new(canvas_w: u32, canvas_h: u32) -> Result<Self, String> {
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

        let out_h = OUT_H;
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
        let uniform = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("layer-uniform"),
            size: std::mem::size_of::<LayerUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let view = texture.create_view(&Default::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        self.slots.insert(path.to_string(), LayerSlot { decoder, texture, bind_group, uniform });
        Ok(())
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

        // Back-to-front by z.
        let mut active: Vec<&super::types::Layer> =
            project.layers.iter().filter(|l| l.active_at(t)).collect();
        active.sort_by_key(|l| l.z);

        // Upload decoded frames + uniforms before encoding the pass.
        let mut draws: Vec<String> = Vec::new();
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

            let r = resolve_layer(layer, t);
            // object-fit: contain into the canvas, then keyframed transform.
            let fit = (cw / mw as f32).min(ch / mh as f32);
            let half_w = mw as f32 * fit * 0.5 * r.scale;
            let half_h = mh as f32 * fit * 0.5 * r.scale;
            let theta = r.rotation_deg.to_radians();
            let u = LayerUniform {
                rot_t: [theta.cos(), theta.sin(), r.x, r.y],
                half_ro: [half_w, half_h, r.corner_radius, r.opacity.clamp(0.0, 1.0)],
                canvas: [cw, ch, 0.0, 0.0],
            };
            self.queue.write_buffer(&slot.uniform, 0, bytemuck::bytes_of(&u));
            draws.push(layer.media_path.clone());
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
            for path in &draws {
                let slot = &self.slots[path];
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
