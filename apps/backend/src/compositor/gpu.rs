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
  grade1:  vec4<f32>, // exposure(stops), contrast, saturation, temperature
  grade2:  vec4<f32>, // tint, _, _, _
  // Effects (foundation session, Phase 4)
  key1:    vec4<f32>, // key r, g, b, tolerance
  key2:    vec4<f32>, // softness, spill, key_enabled, blur px (+blur / -sharpen)
  mask1:   vec4<f32>, // mask cx, cy, half_w, half_h (layer-local px; half_w<=0 → off)
  mask2:   vec4<f32>, // feather px, invert, kind (0 rect / 1 ellipse), vignette 0..1
  fxmode:  vec4<f32>, // blend id (0 normal / 1 multiply / 2 screen / 3 add), _, _, _
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

// Sample + chroma key (foundation, Phase 4). Key distance is measured in the
// CbCr chroma plane — far more stable against luma variation than RGB
// distance. Spill suppression pulls near-key chroma toward luma.
fn key_sample(uv: vec2<f32>) -> vec4<f32> {
  var s = textureSampleLevel(tex, samp, uv, 0.0);
  if (u.key2.z > 0.5) {
    let cb  = 0.5 - 0.168736 * s.r - 0.331264 * s.g + 0.5 * s.b;
    let cr  = 0.5 + 0.5 * s.r - 0.418688 * s.g - 0.081312 * s.b;
    let kcb = 0.5 - 0.168736 * u.key1.x - 0.331264 * u.key1.y + 0.5 * u.key1.z;
    let kcr = 0.5 + 0.5 * u.key1.x - 0.418688 * u.key1.y - 0.081312 * u.key1.z;
    let d = distance(vec2(cb, cr), vec2(kcb, kcr));
    let tol = u.key1.w;
    let soft = max(u.key2.x, 0.0001);
    let a = smoothstep(tol, tol + soft, d);
    let luma = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    let spill_w = (1.0 - smoothstep(tol, tol + soft * 2.0, d)) * u.key2.y;
    s = vec4(mix(s.rgb, vec3(luma, luma, luma), spill_w), s.a * a);
  }
  return s;
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

  // --- sample, with optional 9-tap blur or unsharp sharpen (key applied per
  // tap so keyed edges blur correctly; taps accumulate premultiplied) ---
  var c: vec4<f32>;
  let blur_amt = u.key2.w;
  if (abs(blur_amt) > 0.01) {
    let dims = vec2<f32>(textureDimensions(tex));
    let stp = (abs(blur_amt) * 0.5) / dims;
    var acc = vec4(0.0, 0.0, 0.0, 0.0);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let s = key_sample(in.uv + vec2(f32(dx), f32(dy)) * stp);
        acc += vec4(s.rgb * s.a, s.a);
      }
    }
    let blurred = vec4(acc.rgb / max(acc.a, 0.0001), acc.a / 9.0);
    if (blur_amt > 0.0) {
      c = blurred;
    } else {
      let center = key_sample(in.uv);
      let sharp = center.rgb + (center.rgb - blurred.rgb) * (abs(blur_amt) * 0.15);
      c = vec4(clamp(sharp, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)), center.a);
    }
  } else {
    c = key_sample(in.uv);
  }

  // Color grade (identity when all params are zero): exposure in stops,
  // contrast about mid-gray, saturation via Rec.709 luma, temp/tint as
  // channel offsets. Applied pre-blend, per layer.
  var rgb = c.rgb * exp2(u.grade1.x);
  rgb = (rgb - vec3(0.5, 0.5, 0.5)) * (1.0 + u.grade1.y) + vec3(0.5, 0.5, 0.5);
  let luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma, luma, luma), rgb, 1.0 + u.grade1.z);
  rgb = rgb + vec3(u.grade1.w * 0.1, u.grade2.x * 0.1, -u.grade1.w * 0.1);
  rgb = clamp(rgb, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));

  var alpha = c.a * aa * u.half_ro.w;

  // Shape mask (layer-local space; feathered SDF; invertible).
  if (u.mask1.z > 0.5) {
    let mp = in.local - u.mask1.xy;
    var msd: f32;
    if (u.mask2.z > 0.5) {
      let k = mp / u.mask1.zw;
      msd = (length(k) - 1.0) * min(u.mask1.z, u.mask1.w);
    } else {
      msd = rounded_sd(mp, u.mask1.zw, 0.0);
    }
    let f = max(u.mask2.x, 0.5);
    var ma = 1.0 - smoothstep(-f * 0.5, f * 0.5, msd);
    if (u.mask2.y > 0.5) { ma = 1.0 - ma; }
    alpha = alpha * ma;
  }

  // Vignette: radial darkening toward the layer's visible edges.
  if (u.mask2.w > 0.001) {
    let nd = length(in.local / max(half, vec2(1.0, 1.0)));
    rgb = rgb * (1.0 - u.mask2.w * smoothstep(0.55, 1.35, nd));
  }

  // Blend-mode premultiply transforms; the pipeline's fixed-function factors
  // complete the math (normal keeps straight alpha).
  let mode = u.fxmode.x;
  if (mode == 1.0) { // multiply: lerp toward white by alpha, factors (Dst, Zero)
    return vec4(mix(vec3(1.0, 1.0, 1.0), rgb, alpha), alpha);
  }
  if (mode == 2.0 || mode == 3.0) { // screen (One, OneMinusSrc) / add (One, One)
    return vec4(rgb * alpha, alpha);
  }
  return vec4(rgb, alpha);
}
"#;

// Effect-chain pass (pro-editor session, Phase 2): one effect per pass over
// the layer's SOURCE texture, ping-ponged in USER order before the composite
// pass. Straight alpha in/out; blur premultiplies internally per tap.
const CHAIN_SHADER: &str = r#"
struct FxU {
  op: vec4<f32>,     // x: 1 key, 2 grade, 3 blur, 4 mask, 5 vignette,
                     //    6 wheels, 7 curves, 8 lut3d (y = N for lut3d)
  p0: vec4<f32>,
  p1: vec4<f32>,
  p2: vec4<f32>,
  kcolor: vec4<f32>, // chroma key rgb
  geom: vec4<f32>,   // xy = drawn half-size (layer-local px)
}
@group(0) @binding(0) var<uniform> u: FxU;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var lut_tex: texture_2d<f32>;
@group(0) @binding(4) var lut_samp: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  // Fullscreen triangle.
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4(x, -y, 0.0, 1.0);
  out.uv = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);
  return out;
}

fn key_apply(c: vec4<f32>) -> vec4<f32> {
  // CbCr chroma distance + spill suppression (ported from the composite
  // shader's key_sample — same constants, same look).
  let kc = u.kcolor.rgb;
  let cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  let cr = 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  let kcb = -0.168736 * kc.r - 0.331264 * kc.g + 0.5 * kc.b;
  let kcr = 0.5 * kc.r - 0.418688 * kc.g - 0.081312 * kc.b;
  let dist = distance(vec2(cb, cr), vec2(kcb, kcr));
  let tol = u.p0.x;
  let soft = max(u.p0.y, 0.0001);
  let a = smoothstep(tol, tol + soft, dist);
  var rgb = c.rgb;
  let spill = u.p0.z;
  if (spill > 0.0) {
    let lim = max(rgb.r, rgb.b);
    if (rgb.g > lim) { rgb.g = mix(rgb.g, lim, spill); }
  }
  return vec4(rgb, c.a * a);
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let op = u.op.x;
  var c = textureSample(tex, samp, in.uv);

  if (op == 1.0) { // chroma key
    return key_apply(c);
  }
  if (op == 2.0) { // grade — identical math to the composite pass
    var rgb = c.rgb * exp2(u.p0.x);
    rgb = (rgb - vec3(0.5, 0.5, 0.5)) * (1.0 + u.p0.y) + vec3(0.5, 0.5, 0.5);
    let luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(luma, luma, luma), rgb, 1.0 + u.p0.z);
    rgb = rgb + vec3(u.p0.w * 0.1, u.p1.x * 0.1, -u.p0.w * 0.1);
    return vec4(clamp(rgb, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)), c.a);
  }
  if (op == 3.0) { // 9-tap blur / unsharp sharpen
    let amt = u.p0.x;
    let dims = vec2<f32>(textureDimensions(tex));
    let stp = (abs(amt) * 0.5) / dims;
    var acc = vec4(0.0, 0.0, 0.0, 0.0);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let s = textureSampleLevel(tex, samp, in.uv + vec2(f32(dx), f32(dy)) * stp, 0.0);
        acc += vec4(s.rgb * s.a, s.a);
      }
    }
    let blurred = vec4(acc.rgb / max(acc.a, 0.0001), acc.a / 9.0);
    if (amt > 0.0) { return blurred; }
    let sharp = c.rgb + (c.rgb - blurred.rgb) * (abs(amt) * 0.15);
    return vec4(clamp(sharp, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)), c.a);
  }
  if (op == 4.0) { // mask (feathered SDF, layer-local px, invertible)
    let local = (in.uv - vec2(0.5, 0.5)) * u.geom.xy * 2.0;
    let mp = local - u.p0.xy;
    var msd: f32;
    if (u.p1.z > 0.5) {
      let k = mp / u.p0.zw;
      msd = (length(k) - 1.0) * min(u.p0.z, u.p0.w);
    } else {
      let q = abs(mp) - u.p0.zw;
      msd = length(max(q, vec2(0.0, 0.0))) + min(max(q.x, q.y), 0.0);
    }
    let f = max(u.p1.x, 0.5);
    var ma = 1.0 - smoothstep(-f * 0.5, f * 0.5, msd);
    if (u.p1.y > 0.5) { ma = 1.0 - ma; }
    return vec4(c.rgb, c.a * ma);
  }
  if (op == 5.0) { // vignette
    let local = (in.uv - vec2(0.5, 0.5)) * u.geom.xy * 2.0;
    let nd = length(local / max(u.geom.xy, vec2(1.0, 1.0)));
    let rgb = c.rgb * (1.0 - u.p0.x * smoothstep(0.55, 1.35, nd));
    return vec4(rgb, c.a);
  }
  if (op == 6.0) { // color wheels: lift/gamma/gain per channel
    let lift = vec3(u.p0.x, u.p0.y, u.p0.z);
    let gamma = vec3(u.p0.w, u.p1.x, u.p1.y);
    let gain = vec3(u.p1.z, u.p1.w, u.p2.x);
    var rgb = c.rgb * (vec3(1.0, 1.0, 1.0) + gain) + lift * (vec3(1.0, 1.0, 1.0) - c.rgb);
    rgb = clamp(rgb, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
    let g = vec3(1.0, 1.0, 1.0) / max(vec3(1.0, 1.0, 1.0) + gamma, vec3(0.05, 0.05, 0.05));
    rgb = pow(rgb, g);
    return vec4(clamp(rgb, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)), c.a);
  }
  if (op == 7.0) { // RGB curves: 256x4 rows R,G,B,master (channel, then master)
    var rgb = vec3(
      fn_curve(c.r, 0.0),
      fn_curve(c.g, 1.0),
      fn_curve(c.b, 2.0),
    );
    rgb = vec3(fn_curve(rgb.r, 3.0), fn_curve(rgb.g, 3.0), fn_curve(rgb.b, 3.0));
    return vec4(rgb, c.a);
  }
  if (op == 9.0) { // track matte: binding 3 = matte source texture
    let m = textureSampleLevel(lut_tex, lut_samp, in.uv, 0.0);
    let k = select(m.a, dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), u.p0.x > 0.5);
    return vec4(c.rgb, c.a * k);
  }
  if (op == 10.0) { // motion blur: 8-tap smear along the velocity vector
    let dims = vec2<f32>(textureDimensions(tex));
    let vel = vec2(u.p0.x, u.p0.y) / dims;
    var acc = vec4(0.0, 0.0, 0.0, 0.0);
    for (var i = -4; i <= 4; i++) {
      let s = textureSampleLevel(tex, samp, in.uv + vel * (f32(i) / 8.0), 0.0);
      acc += vec4(s.rgb * s.a, s.a);
    }
    return vec4(acc.rgb / max(acc.a, 0.0001), acc.a / 9.0);
  }
  if (op == 8.0) { // 3D LUT via 2D strip (width N*N, height N; slice = blue)
    let n = u.op.y;
    let bpos = clamp(c.b, 0.0, 1.0) * (n - 1.0);
    let s0 = floor(bpos);
    let s1 = min(s0 + 1.0, n - 1.0);
    let f = bpos - s0;
    let rr = clamp(c.r, 0.0, 1.0) * (n - 1.0);
    let gg = clamp(c.g, 0.0, 1.0) * (n - 1.0);
    let u0 = (s0 * n + rr + 0.5) / (n * n);
    let u1 = (s1 * n + rr + 0.5) / (n * n);
    let vv = (gg + 0.5) / n;
    let a = textureSampleLevel(lut_tex, lut_samp, vec2(u0, vv), 0.0).rgb;
    let b = textureSampleLevel(lut_tex, lut_samp, vec2(u1, vv), 0.0).rgb;
    return vec4(mix(a, b, f), c.a);
  }
  return c;
}

fn fn_curve(v: f32, row: f32) -> f32 {
  // Row centers: (row + 0.5) / 4.
  return textureSampleLevel(
    lut_tex, lut_samp,
    vec2(clamp(v, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, (row + 0.5) / 4.0),
    0.0,
  ).r;
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct FxUniform {
    op: [f32; 4],
    p0: [f32; 4],
    p1: [f32; 4],
    p2: [f32; 4],
    kcolor: [f32; 4],
    geom: [f32; 4],
}

const MAX_CHAIN: usize = 12;
const FX_UNIFORM_STRIDE: u64 = 256; // min uniform buffer offset alignment

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniform {
    rot_t: [f32; 4],
    half_ro: [f32; 4],
    uv_rect: [f32; 4],
    shcolor: [f32; 4],
    canvas: [f32; 4],
    grade1: [f32; 4],
    grade2: [f32; 4],
    key1: [f32; 4],
    key2: [f32; 4],
    mask1: [f32; 4],
    mask2: [f32; 4],
    fxmode: [f32; 4],
}

struct LayerSlot {
    // None for text-raster slots (session 9, Phase 4) — their pixels arrive
    // pre-rendered from the webview instead of an ffmpeg pipe.
    decoder: Option<Decoder>,
    dims: (u32, u32),
    raster_hash: String, // text slots: revision of the uploaded raster
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    // Second uniform+bind group for the shadow pre-pass.
    bind_group_shadow: wgpu::BindGroup,
    uniform_shadow: wgpu::Buffer,
    // Effect chain (Phase 2): ping-pong textures + per-pass uniform slab,
    // allocated lazily the first frame a stack appears on this layer.
    chain_tex: Option<[wgpu::Texture; 2]>,
    chain_uniforms: Option<wgpu::Buffer>,
}

pub struct GpuCompositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    // Indexed by blend id: 0 normal, 1 multiply, 2 screen, 3 add.
    pipelines: [wgpu::RenderPipeline; 4],
    chain_pipeline: wgpu::RenderPipeline,
    chain_bgl: wgpu::BindGroupLayout,
    identity_lut: wgpu::Texture,
    lut_cache: HashMap<u64, wgpu::Texture>,
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

        // Blend modes (foundation, Phase 4): the shader premultiplies per
        // mode; fixed-function factors complete the math. Overlay is omitted
        // — it isn't expressible in fixed-function blending (logged).
        let mk_pipeline = |label: &str, color: wgpu::BlendComponent| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
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
                            color,
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
            })
        };
        let pipelines = [
            // normal: straight alpha
            mk_pipeline(
                "blend-normal",
                wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
            ),
            // multiply: shader outputs lerp(white, rgb, a) → dst * src
            mk_pipeline(
                "blend-multiply",
                wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::Dst,
                    dst_factor: wgpu::BlendFactor::Zero,
                    operation: wgpu::BlendOperation::Add,
                },
            ),
            // screen: shader outputs rgb*a → src + dst*(1-src)
            mk_pipeline(
                "blend-screen",
                wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrc,
                    operation: wgpu::BlendOperation::Add,
                },
            ),
            // add: shader outputs rgb*a → src + dst
            mk_pipeline(
                "blend-add",
                wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::One,
                    operation: wgpu::BlendOperation::Add,
                },
            ),
        ];

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            // Chain samples must not wrap at layer edges (blur taps).
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        // Effect-chain pipeline (Phase 2; binding 3/4 = color LUT strip +
        // its sampler, Phase 5): no blending — each pass rewrites its target.
        let chain_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fx-chain"),
            source: wgpu::ShaderSource::Wgsl(CHAIN_SHADER.into()),
        });
        let chain_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fx-chain"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let chain_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fx-chain"),
            bind_group_layouts: &[&chain_bgl],
            push_constant_ranges: &[],
        });
        let identity_lut = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("identity-lut"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &identity_lut,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255u8, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let chain_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("fx-chain"),
            layout: Some(&chain_pl),
            vertex: wgpu::VertexState {
                module: &chain_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &chain_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
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

        let out_h = out_h.clamp(144, canvas_h.max(144));
        let out_w = (canvas_w as f64 * out_h as f64 / canvas_h as f64).round() as u32 & !1;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("composite-target"),
            size: wgpu::Extent3d {
                width: out_w,
                height: out_h,
                depth_or_array_layers: 1,
            },
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
            pipelines,
            chain_pipeline,
            chain_bgl,
            identity_lut,
            lut_cache: HashMap::new(),
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
        let slot = self.build_slot(w, h, Some(decoder));
        self.slots.insert(path.to_string(), slot);
        Ok(())
    }

    // Text-raster slot: (re)build on size change, upload pixels on revision change.
    fn text_slot_for(&mut self, key: &str, raster: &super::types::TextRaster) {
        let rebuild = match self.slots.get(key) {
            Some(s) => s.dims != (raster.w, raster.h),
            None => true,
        };
        if rebuild {
            let slot = self.build_slot(raster.w, raster.h, None);
            self.slots.insert(key.to_string(), slot);
        }
        let slot = self.slots.get_mut(key).unwrap();
        if slot.raster_hash != raster.hash {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &slot.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &raster.rgba,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(raster.w * 4),
                    rows_per_image: Some(raster.h),
                },
                wgpu::Extent3d {
                    width: raster.w,
                    height: raster.h,
                    depth_or_array_layers: 1,
                },
            );
            slot.raster_hash = raster.hash.clone();
        }
    }

    fn build_slot(&self, w: u32, h: u32, decoder: Option<Decoder>) -> LayerSlot {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("layer"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
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
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buf.as_entire_binding(),
                    },
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
        LayerSlot {
            decoder,
            dims: (w, h),
            raster_hash: String::new(),
            texture,
            bind_group,
            uniform,
            bind_group_shadow,
            uniform_shadow,
            chain_tex: None,
            chain_uniforms: None,
        }
    }

    // "#RRGGBB" or "#RRGGBBAA" → linear-ish rgba floats (target is non-srgb).
    fn parse_rgba(hex: &str, default_alpha: f32) -> [f32; 4] {
        let h = hex.trim_start_matches('#');
        let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
        let a = if h.len() >= 8 {
            p(6) as f32 / 255.0
        } else {
            default_alpha
        };
        [
            p(0) as f32 / 255.0,
            p(2) as f32 / 255.0,
            p(4) as f32 / 255.0,
            a,
        ]
    }

    fn parse_bg(hex: &str) -> wgpu::Color {
        let h = hex.trim_start_matches('#');
        let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
        let srgb_to_linear = |c: u8| {
            let f = c as f64 / 255.0;
            if f <= 0.04045 {
                f / 12.92
            } else {
                ((f + 0.055) / 1.055).powf(2.4)
            }
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
    pub fn render_at(
        &mut self,
        project: &SyncProject,
        t: f64,
        texts: &std::collections::HashMap<String, super::types::TextRaster>,
    ) -> Result<Vec<u8>, String> {
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
            a.z.cmp(&b.z).then(
                a.start
                    .partial_cmp(&b.start)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        });

        // Track mattes (Phase 7): a matted layer multiplies its alpha by the
        // NEXT-HIGHER-z active layer, which is consumed (never composited).
        let mut matte_of: std::collections::HashMap<String, (String, bool)> =
            std::collections::HashMap::new(); // target id → (source path, luma?)
        let mut consumed: std::collections::HashSet<String> = std::collections::HashSet::new();
        for l in &active {
            if l.adjust {
                continue;
            }
            if let Some(kind) = &l.matte {
                if let Some(srcl) = active
                    .iter()
                    .filter(|o| o.z > l.z && !o.adjust && o.id != l.id)
                    .min_by_key(|o| o.z)
                {
                    matte_of.insert(l.id.clone(), (srcl.media_path.clone(), kind == "luma"));
                    consumed.insert(srcl.id.clone());
                }
            }
        }

        // Push transitions (Phase 7): the incoming clip shoves its outgoing
        // partner. Precompute partner offsets so each layer stays
        // independently processable.
        let mut push_map: std::collections::HashMap<String, (f32, f32)> =
            std::collections::HashMap::new();
        for l in &active {
            if let Some(tr) = &l.transitions.in_ {
                if tr.kind.starts_with("push") && t < l.start + tr.duration.max(1e-6) {
                    let p = (((t - l.start) / tr.duration.max(1e-6)).clamp(0.0, 1.0)) as f32;
                    if let Some(partner) = active.iter().find(|o| {
                        o.id != l.id && o.z == l.z && (o.end() - l.start).abs() < 1.0 / fps.max(1.0)
                    }) {
                        let dx = match tr.kind.as_str() {
                            "pushRight" => p * cw,
                            _ => -(p * cw), // push / pushLeft
                        };
                        push_map.insert(partner.id.clone(), (dx, 0.0));
                    }
                }
            }
        }

        // Adjustment layers: resolve each one's (possibly keyframed) grade at t
        // and add it onto every lower-z layer below. ponytail: component-wise
        // sum — exact when the target has no grade of its own; stacked grades
        // approximate (sequential shader passes don't commute into one tuple).
        let adjusts: Vec<(i32, [f32; 5])> = active
            .iter()
            .filter(|l| l.adjust && l.active_at(t))
            .map(|l| (l.z, resolve_layer(l, t).grade))
            .collect();

        // Upload decoded frames + uniforms before encoding the pass.
        let mut draws: Vec<(String, bool, usize)> = Vec::new(); // (path, has_shadow, blend id)
                                                                // Effect chains this frame: (path, pass count). The composite pass for
                                                                // a chained layer binds the chain's final output instead of the source.
                                                                // Per-pass binding-3 source: None = identity, Some(Ok(rev)) = cached
                                                                // LUT, Some(Err(path)) = matte source slot texture.
        type Bind3 = Option<Result<u64, String>>;
        let mut chain_jobs: Vec<(String, usize, Vec<Bind3>)> = Vec::new();
        let mut chained_bg: std::collections::HashMap<String, wgpu::BindGroup> =
            std::collections::HashMap::new();
        for layer in &active {
            if layer.adjust {
                continue; // no pixels of its own
            }
            let is_text = layer.media_path.starts_with("text:");
            let (mw, mh): (u32, u32);
            if is_text {
                // No raster yet (it arrives asynchronously from the webview):
                // skip this frame; the raster IPC marks dirty so we re-render.
                let id = layer.media_path.trim_start_matches("text:");
                let Some(raster) = texts.get(id) else {
                    continue;
                };
                self.text_slot_for(&layer.media_path, raster);
                (mw, mh) = (raster.w, raster.h);
            } else {
                if self.slot_for(&layer.media_path).is_err() {
                    continue; // unreadable media: skip layer, keep compositing the rest
                }
                let src_t = layer.source_time(t);
                let slot = self.slots.get_mut(&layer.media_path).unwrap();
                let dec = slot.decoder.as_mut().expect("media slot has decoder");
                (mw, mh) = (dec.info.width, dec.info.height);
                if let Some(frame) = dec.frame_at(src_t) {
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
                        wgpu::Extent3d {
                            width: mw,
                            height: mh,
                            depth_or_array_layers: 1,
                        },
                    );
                } else {
                    continue;
                }
            }

            if consumed.contains(&layer.id) {
                continue; // matte source: its texture is uploaded, never drawn
            }
            let mut r = resolve_layer(layer, t);
            if let Some((dx, dy)) = push_map.get(&layer.id) {
                r.x += dx;
                r.y += dy;
            }
            for (az, ag) in &adjusts {
                if *az > layer.z {
                    for i in 0..5 {
                        r.grade[i] += ag[i];
                    }
                }
            }

            // --- Transitions (session 7, Part 3) ---
            // In-edge window [start, start+d): dissolve/fade modulate alpha,
            // slide enters from the right, wipe reveals left→right via the
            // crop machinery. Out-edge: fade (and, degraded, any cross type
            // without a partner) modulates alpha toward the end.
            let mut mask_override: Option<([f32; 4], [f32; 3])> = None;
            // Transition library (pro-editor Phase 7). p runs 0→1 over the
            // in-edge window, optionally eased; each type maps p onto the
            // existing composite machinery (opacity/position/rotation/scale/
            // crop reveal) — no new render paths.
            let mut wipe_reveal: f32 = 1.0;
            let mut wipe_axis: u8 = 0; // 0 = from left, 1 right, 2 top, 3 bottom
            let mut wipe_soft: f32 = 0.0;
            if let Some(tr) = &layer.transitions.in_ {
                let d = tr.duration.max(1e-6);
                if t < layer.start + d {
                    let mut p = (((t - layer.start) / d).clamp(0.0, 1.0)) as f32;
                    if tr.ease.as_deref() == Some("easeInOut") {
                        p = if p < 0.5 {
                            4.0 * p * p * p
                        } else {
                            1.0 - (-2.0 * p + 2.0).powi(3) / 2.0
                        };
                    }
                    wipe_soft = tr.softness.clamp(0.0, 1.0) as f32;
                    match tr.kind.as_str() {
                        "dissolve" | "fade" => r.opacity *= p,
                        "slide" | "slideLeft" => r.x += (1.0 - p) * cw,
                        "slideRight" => r.x -= (1.0 - p) * cw,
                        "slideUp" => r.y += (1.0 - p) * ch,
                        "slideDown" => r.y -= (1.0 - p) * ch,
                        // push: the incoming slides in AND shoves the outgoing
                        // partner out (partner offset applied via push_map).
                        "push" | "pushLeft" => r.x += (1.0 - p) * cw,
                        "pushRight" => r.x -= (1.0 - p) * cw,
                        "wipe" | "wipeLeft" => wipe_reveal = p,
                        "wipeRight" => {
                            wipe_reveal = p;
                            wipe_axis = 1;
                        }
                        "wipeUp" => {
                            wipe_reveal = p;
                            wipe_axis = 3;
                        }
                        "wipeDown" => {
                            wipe_reveal = p;
                            wipe_axis = 2;
                        }
                        "zoom" => {
                            r.opacity *= p;
                            r.scale *= 1.25 - 0.25 * p;
                        }
                        "spin" => {
                            r.opacity *= p;
                            r.rotation_deg += (1.0 - p) * 90.0;
                            r.scale *= 0.6 + 0.4 * p;
                        }
                        "iris" => {
                            // Circular reveal riding the mask machinery: an
                            // ellipse mask growing past the layer diagonal.
                            // Applied post-chain via the composite mask
                            // uniforms — set below once dw/dh are known.
                            wipe_reveal = p;
                            wipe_axis = 4;
                        }
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
            // Text rasters are 2x canvas pixels: fixed 0.5 maps them 1:1 onto
            // canvas coordinates (matching the DOM overlay), never contain-fit.
            let fit = if is_text {
                0.5
            } else {
                (cw / mw as f32).min(ch / mh as f32)
            };
            let (dw, dh) = (mw as f32 * fit * r.scale, mh as f32 * fit * r.scale);

            // Synthetic tail ops (Phase 7): motion blur first (smears the
            // content), then the track matte (cuts the silhouette last).
            if layer.motion_blur {
                let dt = 1.0 / fps.max(1.0);
                let ra = resolve_layer(layer, t - dt);
                let rb = resolve_layer(layer, t + dt);
                let fit_guess = if is_text {
                    0.5
                } else {
                    (cw / mw as f32).min(ch / mh as f32)
                };
                let denom = (fit_guess * r.scale).max(1e-3);
                let vx = (rb.x - ra.x) * 0.5 / denom;
                let vy = (rb.y - ra.y) * 0.5 / denom;
                if vx.abs() + vy.abs() > 0.5 {
                    let mut p = [0.0f32; 12];
                    p[0] = vx.clamp(-64.0, 64.0);
                    p[1] = vy.clamp(-64.0, 64.0);
                    r.chain.push(super::types::ChainOp {
                        op: 10,
                        p,
                        color: [0.0; 3],
                        lut: None,
                    });
                }
            }
            let matte_src = matte_of.get(&layer.id).cloned();
            if let Some((_, luma)) = &matte_src {
                let mut p = [0.0f32; 12];
                p[0] = if *luma { 1.0 } else { 0.0 };
                r.chain.push(super::types::ChainOp {
                    op: 9,
                    p,
                    color: [0.0; 3],
                    lut: None,
                });
            }

            // --- Effect chain (Phase 2): ping-pong the stack in user order
            // over the source texture; the composite below binds the result.
            if !r.chain.is_empty() {
                let n = r.chain.len().min(MAX_CHAIN);
                if r.chain.len() > MAX_CHAIN {
                    log::warn!(
                        "layer {}: {} effects, chain capped at {MAX_CHAIN} (extra passes dropped)",
                        layer.id,
                        r.chain.len()
                    );
                }
                // Allocate/refresh chain resources.
                {
                    let slot = self.slots.get_mut(&layer.media_path).unwrap();
                    if slot.chain_tex.is_none() {
                        let mk = |label: &str| {
                            self.device.create_texture(&wgpu::TextureDescriptor {
                                label: Some(label),
                                size: wgpu::Extent3d {
                                    width: slot.dims.0,
                                    height: slot.dims.1,
                                    depth_or_array_layers: 1,
                                },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::Rgba8Unorm,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING
                                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                                view_formats: &[],
                            })
                        };
                        slot.chain_tex = Some([mk("chain-a"), mk("chain-b")]);
                        slot.chain_uniforms =
                            Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                                label: Some("chain-uniforms"),
                                size: FX_UNIFORM_STRIDE * MAX_CHAIN as u64,
                                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                                mapped_at_creation: false,
                            }));
                    }
                }
                // Per-pass uniforms (geom = full drawn half-size pre-crop).
                let slot = &self.slots[&layer.media_path];
                let ubuf = slot.chain_uniforms.as_ref().unwrap();
                for (i, opc) in r.chain.iter().take(n).enumerate() {
                    let u = FxUniform {
                        // op.y carries the 3D LUT's N (slice count).
                        op: [opc.op as f32, opc.p[0], 0.0, 0.0],
                        p0: [opc.p[0], opc.p[1], opc.p[2], opc.p[3]],
                        p1: [opc.p[4], opc.p[5], opc.p[6], opc.p[7]],
                        p2: [opc.p[8], opc.p[9], opc.p[10], opc.p[11]],
                        kcolor: [opc.color[0], opc.color[1], opc.color[2], 0.0],
                        geom: [dw * 0.5, dh * 0.5, 0.0, 0.0],
                    };
                    self.queue.write_buffer(
                        ubuf,
                        i as u64 * FX_UNIFORM_STRIDE,
                        bytemuck::bytes_of(&u),
                    );
                    // Color data (curves rows / 3D LUT strip): upload once per
                    // revision; the cache key is the resolver-computed rev.
                    if let Some(lut) = &opc.lut {
                        if !self.lut_cache.contains_key(&lut.rev) {
                            let tex = self.device.create_texture(&wgpu::TextureDescriptor {
                                label: Some("fx-lut"),
                                size: wgpu::Extent3d {
                                    width: lut.w,
                                    height: lut.h,
                                    depth_or_array_layers: 1,
                                },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::Rgba8Unorm,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING
                                    | wgpu::TextureUsages::COPY_DST,
                                view_formats: &[],
                            });
                            self.queue.write_texture(
                                wgpu::TexelCopyTextureInfo {
                                    texture: &tex,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                &lut.rgba,
                                wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(lut.w * 4),
                                    rows_per_image: Some(lut.h),
                                },
                                wgpu::Extent3d {
                                    width: lut.w,
                                    height: lut.h,
                                    depth_or_array_layers: 1,
                                },
                            );
                            // ponytail: unbounded cache; evict-on-count if LUT
                            // churn ever becomes real.
                            self.lut_cache.insert(lut.rev, tex);
                        }
                    }
                }
                // Composite bind group pointing at the chain's final output.
                let final_tex = &slot.chain_tex.as_ref().unwrap()[(n - 1) % 2];
                let final_view = final_tex.create_view(&Default::default());
                chained_bg.insert(
                    layer.media_path.clone(),
                    self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("composite-chained"),
                        layout: &self.bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: slot.uniform.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::TextureView(&final_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::Sampler(&self.sampler),
                            },
                        ],
                    }),
                );
                chain_jobs.push((
                    layer.media_path.clone(),
                    n,
                    r.chain
                        .iter()
                        .take(n)
                        .map(|o| {
                            if o.op == 9 {
                                matte_src.as_ref().map(|(p, _)| Err(p.clone()))
                            } else {
                                o.lut.as_ref().map(|l| Ok(l.rev))
                            }
                        })
                        .collect(),
                ));
            }

            // Crop cuts pixels away from the fitted rect (Premiere semantics):
            // the visible sub-rect keeps its on-canvas position; its center
            // shifts by the crop asymmetry, rotating with the layer.
            let (mut cl, mut ct2, mut cr2, mut cb) = sane_crop(&r.crop);
            if wipe_axis == 4 && wipe_reveal < 1.0 {
                // iris: feathered ellipse mask reveal in the composite pass.
                // Overrides any authored mask for the transition window
                // (transitions are short; logged).
                let diag = (dw * dw + dh * dh).sqrt() * 0.5;
                let rr = (wipe_reveal * 1.05) * diag + 1.0;
                mask_override = Some((
                    [0.0, 0.0, rr, rr],
                    [(wipe_soft * diag * 0.5).max(6.0), 0.0, 1.0],
                ));
            } else if wipe_reveal < 1.0 {
                // Reveal fraction of the (user-cropped) visible extent, from
                // the chosen edge.
                let take = 1.0 - wipe_reveal;
                match wipe_axis {
                    1 => cl = (cl + take * (1.0 - cl - cr2)).min(0.999),
                    2 => cb = (cb + take * (1.0 - ct2 - cb)).min(0.999),
                    3 => ct2 = (ct2 + take * (1.0 - ct2 - cb)).min(0.999),
                    _ => cr2 = (cr2 + take * (1.0 - cl - cr2)).min(0.999),
                }
            }
            let half_w = dw * (1.0 - cl - cr2) * 0.5;
            let half_h = dh * (1.0 - ct2 - cb) * 0.5;
            let off = ((cl - cr2) * 0.5 * dw, (ct2 - cb) * 0.5 * dh);
            let theta = r.rotation_deg.to_radians();
            let (cos, sin) = (theta.cos(), theta.sin());
            let tx = r.x + off.0 * cos - off.1 * sin;
            let ty = r.y + off.0 * sin + off.1 * cos;

            // Effect stack (Phase 2): the layer's own effects run as CHAIN
            // passes before this composite; here only the adjustment-layer
            // grade fold survives (r.grade — zero for normal layers), the
            // rest of the legacy uniforms sit at identity.
            let content = LayerUniform {
                rot_t: [cos, sin, tx, ty],
                half_ro: [half_w, half_h, r.corner_radius, r.opacity.clamp(0.0, 1.0)],
                uv_rect: [cl, ct2, 1.0 - cr2, 1.0 - cb],
                shcolor: [0.0; 4],
                canvas: [cw, ch, 0.0, 0.0],
                grade1: [r.grade[0], r.grade[1], r.grade[2], r.grade[3]],
                grade2: [r.grade[4], 0.0, 0.0, 0.0],
                key1: [0.0; 4],
                key2: [0.0; 4],
                // Composite mask stays identity except for the iris
                // transition override (Phase 7).
                mask1: mask_override.map(|(m1, _)| m1).unwrap_or([0.0; 4]),
                mask2: mask_override
                    .map(|(_, m2)| [m2[0], 0.0, m2[2], 0.0])
                    .unwrap_or([0.0; 4]),
                fxmode: [
                    match layer.blend.as_deref() {
                        Some("multiply") => 1.0,
                        Some("screen") => 2.0,
                        Some("add") => 3.0,
                        _ => 0.0,
                    },
                    0.0,
                    0.0,
                    0.0,
                ],
            };
            let slot = &self.slots[&layer.media_path];
            self.queue
                .write_buffer(&slot.uniform, 0, bytemuck::bytes_of(&content));

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
                        ..Default::default()
                    };
                    self.queue
                        .write_buffer(&slot.uniform_shadow, 0, bytemuck::bytes_of(&shadow_u));
                }
            }
            let blend = match layer.blend.as_deref() {
                Some("multiply") => 1,
                Some("screen") => 2,
                Some("add") => 3,
                _ => 0,
            };
            draws.push((layer.media_path.clone(), has_shadow, blend));
        }

        let view = self.target.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        // Chain passes first: each writes chain_tex[i%2] reading the source
        // (pass 0) or the other ping-pong texture.
        for (path, n, lut_revs) in &chain_jobs {
            let slot = &self.slots[path];
            let texs = slot.chain_tex.as_ref().unwrap();
            let ubuf = slot.chain_uniforms.as_ref().unwrap();
            for i in 0..*n {
                let input_view = if i == 0 {
                    slot.texture.create_view(&Default::default())
                } else {
                    texs[(i - 1) % 2].create_view(&Default::default())
                };
                let lut_view = match &lut_revs[i] {
                    Some(Ok(rev)) => self
                        .lut_cache
                        .get(rev)
                        .unwrap_or(&self.identity_lut)
                        .create_view(&Default::default()),
                    Some(Err(matte_path)) => self
                        .slots
                        .get(matte_path)
                        .map(|s| &s.texture)
                        .unwrap_or(&self.identity_lut)
                        .create_view(&Default::default()),
                    None => self.identity_lut.create_view(&Default::default()),
                };
                let bg =
                    self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("chain-pass"),
                        layout: &self.chain_bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                    buffer: ubuf,
                                    offset: i as u64 * FX_UNIFORM_STRIDE,
                                    size: wgpu::BufferSize::new(
                                        std::mem::size_of::<FxUniform>() as u64
                                    ),
                                }),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::Sampler(&self.sampler),
                            },
                            wgpu::BindGroupEntry {
                                binding: 3,
                                resource: wgpu::BindingResource::TextureView(&lut_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 4,
                                resource: wgpu::BindingResource::Sampler(&self.sampler),
                            },
                        ],
                    });
                let out_view = texs[i % 2].create_view(&Default::default());
                let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("fx-chain"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &out_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(&self.chain_pipeline);
                pass.set_bind_group(0, &bg, &[]);
                pass.draw(0..3, 0..1);
            }
        }
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
            for (path, has_shadow, blend) in &draws {
                let slot = &self.slots[path];
                if *has_shadow {
                    // Shadows always composite normally.
                    pass.set_pipeline(&self.pipelines[0]);
                    pass.set_bind_group(0, &slot.bind_group_shadow, &[]);
                    pass.draw(0..6, 0..1);
                }
                pass.set_pipeline(&self.pipelines[*blend]);
                pass.set_bind_group(0, chained_bg.get(path).unwrap_or(&slot.bind_group), &[]);
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
            wgpu::Extent3d {
                width: self.out_w,
                height: self.out_h,
                depth_or_array_layers: 1,
            },
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

    pub fn dump_png(
        &mut self,
        project: &SyncProject,
        t: f64,
        path: &std::path::Path,
    ) -> Result<(), String> {
        self.dump_png_texts(project, t, &std::collections::HashMap::new(), path)
    }

    pub fn dump_png_texts(
        &mut self,
        project: &SyncProject,
        t: f64,
        texts: &std::collections::HashMap<String, super::types::TextRaster>,
        path: &std::path::Path,
    ) -> Result<(), String> {
        let pixels = self.render_at(project, t, texts)?;
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), self.out_w, self.out_h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&pixels).map_err(|e| e.to_string())?;
        Ok(())
    }
}
