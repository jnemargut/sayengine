// sway shader for "grass" (studio, Decision 52): blades bend with a travelling gust, root fixed
shader_type spatial;
render_mode cull_disabled;
uniform vec4 albedo : source_color = vec4(0.4353, 0.6039, 0.2627, 1.0);
uniform vec3 wind = vec3(0.9578, 0.0000, 0.2873);
uniform float strength = 16.00;
uniform float blade_height = 0.300;
uniform float gust_k = 2.5133;
uniform float per = 0.4545;
uniform float energy = 0.50;
void vertex() {
  float k = clamp(VERTEX.y / (blade_height * 1.3), 0.0, 1.0);
  float ph = gust_k * dot(VERTEX.xz, wind.xz);
  float deg = strength * (0.6 + energy * 0.8) * (0.55 + 0.45 * sin(TAU * per * TIME - ph)) + 3.0 * sin(TAU * per * 3.0 * TIME + VERTEX.x * 7.0 + VERTEX.z * 5.0);
  float a = radians(deg) * k;
  float h = VERTEX.y;
  VERTEX.xz += wind.xz * sin(a) * h;
  VERTEX.y = h * cos(a);
}
void fragment() { ALBEDO = albedo.rgb; ROUGHNESS = 0.9; }
