import { nativeFunction } from "./native-kernels.js";

const hash = nativeFunction(
  `float riverHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}`,
  `fn riverHash(p:vec2f)->f32{return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}`,
);
const noise = nativeFunction(
  `float riverNoise(vec2 uv,float grid){vec2 p=uv*grid;vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);return mix(mix(riverHash(mod(i,grid)),riverHash(mod(i+vec2(1.,0.),grid)),f.x),mix(riverHash(mod(i+vec2(0.,1.),grid)),riverHash(mod(i+vec2(1.),grid)),f.x),f.y);}`,
  `fn riverNoise(uv:vec2f,grid:f32)->f32{let p=uv*grid;let i=floor(p);var f=fract(p);f=f*f*(3.-2.*f);let a=i-floor(i/grid)*grid;let b=i+vec2f(1.,0.);let c=i+vec2f(0.,1.);let d=i+vec2f(1.);return mix(mix(riverHash(a),riverHash(b-floor(b/grid)*grid),f.x),mix(riverHash(c-floor(c/grid)*grid),riverHash(d-floor(d/grid)*grid),f.x),f.y);}`,
  [hash],
);
const height = nativeFunction(
  `float riverHeight(vec2 uv){return riverNoise(uv,8.)*.52+riverNoise(uv+vec2(.23,.17),16.)*.28+riverNoise(uv,32.)*.14+riverNoise(uv,64.)*.06;}`,
  `fn riverHeight(uv:vec2f)->f32{return riverNoise(uv,8.)*.52+riverNoise(uv+vec2f(.23,.17),16.)*.28+riverNoise(uv,32.)*.14+riverNoise(uv,64.)*.06;}`,
  [noise],
);
export const riverTile = nativeFunction(
  `vec4 riverTile(vec2 uv){vec2 e=vec2(1./256.,0.);vec2 slope=vec2(riverHeight(uv+e.xy)-riverHeight(uv-e.xy),riverHeight(uv+e.yx)-riverHeight(uv-e.yx));return vec4(clamp(.5+slope*3.,0.,1.),riverNoise(uv,32.),riverNoise(uv,8.));}`,
  `fn riverTile(uv:vec2f)->vec4f{let e=vec2f(1./256.,0.);let slope=vec2f(riverHeight(uv+e.xy)-riverHeight(uv-e.xy),riverHeight(uv+e.yx)-riverHeight(uv-e.yx));return vec4f(clamp(vec2f(.5)+slope*3.,vec2f(0.),vec2f(1.)),riverNoise(uv,32.),riverNoise(uv,8.));}`,
  [height, noise],
);

export const riverSurface = nativeFunction(
  `vec4 riverSurface(sampler2D map,vec2 coord,vec4 flow,float time,float distanceToEye){
    float phase=fract(time/6.);float other=fract(phase+.5);float blend=1.-abs(phase*2.-1.);
    vec2 a=coord-flow.xy*(phase*6.*flow.z),b=coord-flow.xy*(other*6.*flow.z);
    vec4 broad=mix(texture(map,b*vec2(.16,.24)),texture(map,a*vec2(.16,.24)),blend);
    vec4 fine=mix(texture(map,b*vec2(.59,.71)+vec2(.37,.19)),texture(map,a*vec2(.59,.71)+vec2(.37,.19)),blend);
    float detail=1.-smoothstep(20.,180.,distanceToEye);
    vec2 slope=(broad.rg-.5)*.65+(fine.rg-.5)*.26*detail;
    slope.y+=sin(coord.y*3.8-time*flow.z*3.8+sin(coord.x*1.7))*.025*detail;
    vec2 horizontal=slope;
    float shallow=smoothstep(.04,.18,flow.w)*(1.-smoothstep(.25,.8,flow.w));
    float foam=smoothstep(.57,.81,broad.b*.55+fine.b*.45)*shallow*.68;
    return vec4(normalize(vec3(-horizontal.x,1.,-horizontal.y-.0018)),foam);
  }`,
  `fn riverSurface(map:texture_2d<f32>,linearSampler:sampler,coord:vec2f,flow:vec4f,time:f32,distanceToEye:f32)->vec4f{
    let phase=fract(time/6.);let other=fract(phase+.5);let blend=1.-abs(phase*2.-1.);
    let a=coord-flow.xy*(phase*6.*flow.z);let b=coord-flow.xy*(other*6.*flow.z);
    let broad=mix(textureSample(map,linearSampler,b*vec2f(.16,.24)),textureSample(map,linearSampler,a*vec2f(.16,.24)),blend);
    let fine=mix(textureSample(map,linearSampler,b*vec2f(.59,.71)+vec2f(.37,.19)),textureSample(map,linearSampler,a*vec2f(.59,.71)+vec2f(.37,.19)),blend);
    let detail=1.-smoothstep(20.,180.,distanceToEye);
    var slope=(broad.rg-vec2f(.5))*.65+(fine.rg-vec2f(.5))*.26*detail;
    slope.y+=sin(coord.y*3.8-time*flow.z*3.8+sin(coord.x*1.7))*.025*detail;
    let horizontal=slope;
    let shallow=smoothstep(.04,.18,flow.w)*(1.-smoothstep(.25,.8,flow.w));
    let foam=smoothstep(.57,.81,broad.b*.55+fine.b*.45)*shallow*.68;
    return vec4f(normalize(vec3f(-horizontal.x,1.,-horizontal.y-.0018)),foam);
  }`,
);

export const riverDisplacement = nativeFunction(
  `vec3 riverDisplacement(vec3 p,vec2 coord,float depth,float speed,float time){float edge=smoothstep(.05,.55,depth);float h=sin(coord.y*1.9-time*speed*1.9+coord.x*.7)*.012+sin(coord.y*3.1-time*speed*3.1-coord.x*1.1)*.007;return p+vec3(0.,h*edge,0.);}`,
  `fn riverDisplacement(p:vec3f,coord:vec2f,depth:f32,speed:f32,time:f32)->vec3f{let edge=smoothstep(.05,.55,depth);let h=sin(coord.y*1.9-time*speed*1.9+coord.x*.7)*.012+sin(coord.y*3.1-time*speed*3.1-coord.x*1.1)*.007;return p+vec3f(0.,h*edge,0.);}`,
);
