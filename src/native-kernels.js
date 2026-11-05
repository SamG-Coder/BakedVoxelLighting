import { wgslFn, Fn } from "three/tsl";
import volumeWGSL from "./shaders/volume.wgsl?raw";
// Native WGSL helpers. WebGPU is the only backend, so there is no GLSL twin.
export function nativeFunction(wgsl, includes = []) {
  const w = wgslFn(
    wgsl,
    includes.map((k) => k.wgsl),
  );
  const kernel = (parameters) => Fn(() => w(parameters))();
  kernel.wgsl = w;
  return kernel;
}
export const volumeKernel = nativeFunction(volumeWGSL);
export const rotatePlant = nativeFunction(
  `fn rotatePlant(v:vec3f,a:f32)->vec3f{return vec3f(v.x*cos(a)+v.z*sin(a),v.y,v.z*cos(a)-v.x*sin(a));}`,
);
export const grassNormal = nativeFunction(
  `fn grassNormal(detail:vec3f,yaw:f32)->vec3f{let n=normalize(vec3f(detail.x*.34,.78,detail.y*.34));return vec3f(n.x*cos(yaw)+n.z*sin(yaw),n.y,n.z*cos(yaw)-n.x*sin(yaw));}`,
);
export const windPosition = nativeFunction(
  `fn windPosition(p:vec3f,t:f32,id:f32,anchor:vec3f,y:f32,v:f32,strength:f32)->vec3f{let phase=dot(anchor.xz,vec2f(.083,.061))+t*.85;let gust=.65+.35*sin(phase*.37);let sway=sin(phase)+.26*sin(t*2.3+id*.73+y);return p+vec3f(sway*.82,0.,sin(phase*.83+.7)*.57)*strength*gust*v*v;}`,
);
export const fadeMask = nativeFunction(
  `fn fadeMask(p:vec2f,range:vec2f)->bool{let n=fract(52.9829189*fract(dot(floor(p),vec2f(.06711056,.00583715))));return n>=range.x&&n<range.y;}`,
);
export const atlasUV = nativeFunction(
  `fn atlasUV(uv:vec2f,angle:f32,yaw:f32,views:f32,row:f32,rows:f32)->vec2f{let index=floor((angle-yaw)/6.28318530718*views+.5)+views;let frame=index-floor(index/views)*views;return vec2f((uv.x+frame)/views,(uv.y+row)/rows);}`,
);
export const foliageRadiance = nativeFunction(
  `fn foliageRadiance(n:vec3f,indirect:vec3f,bent:vec3f,enabled:f32,sun:vec3f,visibility:f32,lamp:vec3f,power:f32,thin:f32,daylight:f32,sunColour:vec3f,lampColour:vec3f)->vec3f{let result=indirect*enabled*(.7+.3*max(dot(n,normalize(bent)),0.));let back=pow(max(dot(-n,sun),0.),.65);let sunPass=mix(1.,visibility,enabled);let local=power/(12.+dot(lamp,lamp));return result+thin*(sunColour*(.04+.5*back)*sunPass*daylight+lampColour*local*(.25+.75*max(dot(-n,normalize(lamp)),0.)));}`,
);
export const groundBlend = nativeFunction(
  `fn groundBlend(p:vec3f,camera:vec3f,land:vec4f,soil:vec3f,lush:vec3f,dry:vec3f,stone:vec3f,rockWeight:f32,soilHeight:f32,micro:f32,root:f32,bank:vec2f,cover:vec4f,surface:vec3f,mean:vec3f,forestFloor:vec3f,woodland:f32,macroTone:f32)->vec3f{var meadow=mix(dry,lush,smoothstep(.22,.64,land.b));var wear=max(smoothstep(.08,.72,land.g),smoothstep(.08,.65,root)*.92);wear=clamp(wear+(soilHeight-.5)*wear*(1.-wear)*micro,0.,1.);let rock=rockWeight;let macroTint=macroTone;let far=smoothstep(90.,300.,distance(camera,p));let grass=cover.rgb*clamp(surface/max(mean,vec3f(.012)),vec3f(.35),vec3f(2.4));meadow=mix(meadow,grass,mix(cover.a*.45,smoothstep(0.,.52,cover.a),far));let base=mix(mix(mix(meadow*macroTint,soil,wear),stone,rock*(1.-wear))*(1.-land.b*.12),forestFloor*macroTint,woodland*(1.-smoothstep(.08,.45,land.g)));return mix(base,mix(soil*.58,stone*.84,bank.y)*macroTint,bank.x*(1.-smoothstep(.3,.85,land.g)));}`,
);
export const sampleAtlas = nativeFunction(
  `fn sampleAtlas(map:texture_2d<f32>,linearSampler:sampler,p:vec3f,origin:vec3f,extent:vec3f,dims:vec3f,fallback:vec4f,flipY:f32)->vec4f{let local=(p-origin)/extent;if(any(local<vec3f(0.))||any(local>vec3f(1.))){return fallback;}let c=clamp(local*dims-vec3f(.5),vec3f(0.),dims-vec3f(1.));let y=floor(c.y);var a=vec2f((c.x+.5)/dims.x,(c.z+.5+y*dims.z)/(dims.z*dims.y));var b=vec2f(a.x,(c.z+.5+min(y+1.,dims.y-1.)*dims.z)/(dims.z*dims.y));if(flipY>.5){a.y=1.-a.y;b.y=1.-b.y;}let edge=min(local,vec3f(1.)-local)*extent;let weight=smoothstep(0.,24.,min(edge.x,edge.z))*smoothstep(0.,6.,edge.y);return mix(fallback,mix(textureSampleLevel(map,linearSampler,a,0.),textureSampleLevel(map,linearSampler,b,0.),fract(c.y)),weight);}`,
);
export const normalKernel = nativeFunction(
  `fn normalKernel(map:texture_2d<f32>,linearSampler:sampler,uv:vec2f,texel:vec2f,strength:f32)->vec4f{let l=textureSampleLevel(map,linearSampler,uv-vec2f(texel.x,0.),0.);let r=textureSampleLevel(map,linearSampler,uv+vec2f(texel.x,0.),0.);let b=textureSampleLevel(map,linearSampler,uv-vec2f(0.,texel.y),0.);let t=textureSampleLevel(map,linearSampler,uv+vec2f(0.,texel.y),0.);let weights=vec3f(.299,.587,.114);let dx=dot(r.rgb,weights)*r.a-dot(l.rgb,weights)*l.a;let dy=dot(t.rgb,weights)*t.a-dot(b.rgb,weights)*b.a;return vec4f(normalize(vec3f(-dx*strength,-dy*strength,1.))*.5+vec3f(.5),1.);}`,
);
export const nativeVolumeSource = volumeWGSL;

export const skyColour =
  nativeFunction(`fn skyColour(ray:vec3f,sun:vec3f,cloud:vec4f,daylight:f32)->vec3f{
 let altitude=pow(max(ray.y,0.),.42);let toward=max(dot(ray,sun),0.);
 var sky=mix(vec3f(.40,.60,.82),vec3f(.045,.20,.53),altitude);
 let dusk=1.-smoothstep(.02,.30,sun.y);
 sky=mix(sky,mix(vec3f(.85,.43,.20),sky,smoothstep(0.,.5,ray.y)),dusk*.65);
 sky+=vec3f(1.,.76,.42)*(pow(toward,256.)*.26+pow(toward,24.)*.035);
 let cloudLight=mix(cloud.rgb,cloud.rgb*vec3f(1.,.74,.52),dusk*.55);
 return mix(mix(vec3f(.006,.012,.028),vec3f(.025,.032,.045),cloud.a),sky*(1.-cloud.a)+cloudLight,daylight);
}`);

// Moss has its own linear reflectance rather than multiplying green into dark bark.
// Irregular age masks are baked per vertex; moisture and stable exposure govern coverage.
export const mossSurface = nativeFunction(
  `fn mossSurface(bark:vec3f,coverage:f32,n:vec3f,habitat:vec2f)->vec3f{let exposure=.5*(max(dot(n,vec3f(-.55,.70,-.44)),0.)+max(dot(n,vec3f(.55,.70,.44)),0.))+.4*max(n.y,0.);let shelter=1.-clamp(exposure*(1.-habitat.y*.88),0.,1.);let climate=smoothstep(.12,.65,habitat.x)*(.08+.92*pow(shelter,3.));let fine=clamp(dot(bark,vec3f(.2126,.7152,.0722))*3.,0.,1.);let mask=clamp(coverage*climate,0.,1.);return mix(bark,mix(vec3f(.022,.047,.006),vec3f(.075,.13,.017),fine),mask);}`,
);
