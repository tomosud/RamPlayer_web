struct Params {
  width: u32,
  height: u32,
  frameSlot: u32,
  isFirstFrame: u32,
}

@group(0) @binding(0) var currentFrame: texture_external;
@group(0) @binding(1) var frameSampler: sampler;
@group(0) @binding(2) var previousLuma: texture_2d<f32>;
@group(0) @binding(3) var outputLuma: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var<storage, read_write> scores: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(f32(params.width), f32(params.height));
  let rgb = textureSampleBaseClampToEdge(currentFrame, frameSampler, uv).rgb;
  let currentY = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  textureStore(outputLuma, vec2i(id.xy), vec4f(currentY, 0.0, 0.0, 1.0));
  if (params.isFirstFrame == 0u) {
    let previousY = textureLoad(previousLuma, vec2i(id.xy), 0).r;
    atomicAdd(&scores[params.frameSlot], u32(abs(currentY - previousY) * 65535.0));
  }
}
