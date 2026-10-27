import { glslFn, wgslFn, Fn } from "three/tsl";
import volumeGLSL from "./shaders/volume.glsl?raw";
import volumeWGSL from "./shaders/volume.wgsl?raw";
let gpu = true;
export function setShaderBackend(value) {
  gpu = value;
}
export function nativeFunction(glsl, wgsl, includes = []) {
  const g = glslFn(
      glsl,
      includes.map((k) => k.glsl),
    ),
    w = wgslFn(
      wgsl,
      includes.map((k) => k.wgsl),
    );
  const textures = new Set(
    [...glsl.matchAll(/sampler[23]D\s+(\w+)/g)].map((m) => m[1]),
  );
  const kernel = (parameters) =>
    Fn(() => {
      // GLSL combines texture and sampler. Three's TextureNode treats sampler*
      // outputs as WGSL sampler bindings, so pass the texture property explicitly.
      const bindings = gpu
        ? parameters
        : Object.fromEntries(
            Object.entries(parameters).map(([name, node]) => [
              name,
              textures.has(name) ? node.convert("property") : node,
            ]),
          );
      return (gpu ? w : g)(bindings);
    })();
  kernel.glsl = g;
  kernel.wgsl = w;
  return kernel;
}
export const volumeKernel = nativeFunction(volumeGLSL, volumeWGSL);
export const rotatePlant = nativeFunction(
  `vec3 rotatePlant(vec3 v,float a){return vec3(v.x*cos(a)+v.z*sin(a),v.y,v.z*cos(a)-v.x*sin(a));}`,
  `fn rotatePlant(v:vec3f,a:f32)->vec3f{return vec3f(v.x*cos(a)+v.z*sin(a),v.y,v.z*cos(a)-v.x*sin(a));}`,
);
export const grassNormal = nativeFunction(
  `vec3 grassNormal(vec3 detail,float yaw){vec3 n=normalize(vec3(detail.x*.34,.78,detail.y*.34));return vec3(n.x*cos(yaw)+n.z*sin(yaw),n.y,n.z*cos(yaw)-n.x*sin(yaw));}`,
  `fn grassNormal(detail:vec3f,yaw:f32)->vec3f{let n=normalize(vec3f(detail.x*.34,.78,detail.y*.34));return vec3f(n.x*cos(yaw)+n.z*sin(yaw),n.y,n.z*cos(yaw)-n.x*sin(yaw));}`,
);
export const windPosition = nativeFunction(
  `vec3 windPosition(vec3 p,float t,float id,vec3 anchor,float y,float v,float strength){float phase=dot(anchor.xz,vec2(.083,.061))+t*.85;float gust=.65+.35*sin(phase*.37);float sway=sin(phase)+.26*sin(t*2.3+id*.73+y);return p+vec3(sway*.82,0.,sin(phase*.83+.7)*.57)*strength*gust*v*v;}`,
  `fn windPosition(p:vec3f,t:f32,id:f32,anchor:vec3f,y:f32,v:f32,strength:f32)->vec3f{let phase=dot(anchor.xz,vec2f(.083,.061))+t*.85;let gust=.65+.35*sin(phase*.37);let sway=sin(phase)+.26*sin(t*2.3+id*.73+y);return p+vec3f(sway*.82,0.,sin(phase*.83+.7)*.57)*strength*gust*v*v;}`,
);
export const fadeMask = nativeFunction(
  `bool fadeMask(vec2 p,vec2 range){float n=fract(52.9829189*fract(dot(floor(p),vec2(.06711056,.00583715))));return n>=range.x&&n<range.y;}`,
  `fn fadeMask(p:vec2f,range:vec2f)->bool{let n=fract(52.9829189*fract(dot(floor(p),vec2f(.06711056,.00583715))));return n>=range.x&&n<range.y;}`,
);
export const atlasUV = nativeFunction(
  `vec2 atlasUV(vec2 uv,float angle,float yaw,float views,float row,float rows){float frame=mod(floor((angle-yaw)/6.28318530718*views+.5)+views,views);return vec2((uv.x+frame)/views,(uv.y+row)/rows);}`,
  `fn atlasUV(uv:vec2f,angle:f32,yaw:f32,views:f32,row:f32,rows:f32)->vec2f{let index=floor((angle-yaw)/6.28318530718*views+.5)+views;let frame=index-floor(index/views)*views;return vec2f((uv.x+frame)/views,(uv.y+row)/rows);}`,
);
export const foliageRadiance = nativeFunction(
  `vec3 foliageRadiance(vec3 n,vec3 indirect,vec3 bent,float enabled,vec3 sun,float visibility,vec3 lamp,float power,float thin,float daylight,vec3 sunColour,vec3 lampColour){vec3 result=indirect*enabled*(.7+.3*max(dot(n,normalize(bent)),0.));float back=pow(max(dot(-n,sun),0.),.65);float sunPass=mix(1.,visibility,enabled);float local=power/(12.+dot(lamp,lamp));return result+thin*(sunColour*(.04+.5*back)*sunPass*daylight+lampColour*local*(.25+.75*max(dot(-n,normalize(lamp)),0.)));}`,
  `fn foliageRadiance(n:vec3f,indirect:vec3f,bent:vec3f,enabled:f32,sun:vec3f,visibility:f32,lamp:vec3f,power:f32,thin:f32,daylight:f32,sunColour:vec3f,lampColour:vec3f)->vec3f{let result=indirect*enabled*(.7+.3*max(dot(n,normalize(bent)),0.));let back=pow(max(dot(-n,sun),0.),.65);let sunPass=mix(1.,visibility,enabled);let local=power/(12.+dot(lamp,lamp));return result+thin*(sunColour*(.04+.5*back)*sunPass*daylight+lampColour*local*(.25+.75*max(dot(-n,normalize(lamp)),0.)));}`,
);
export const groundBlend = nativeFunction(
  `vec3 groundBlend(vec3 p,vec3 camera,vec4 land,vec3 soil,vec3 lush,vec3 dry,vec3 stone,float root,vec2 bank,vec4 cover,vec3 surface,vec3 mean,vec3 forestFloor,float woodland){vec3 meadow=mix(dry,lush,smoothstep(.22,.64,land.b));float wear=max(smoothstep(.08,.72,land.g),smoothstep(.08,.65,root)*.92);float rock=smoothstep(.32,.72,land.a);float macroTint=.90+.10*sin(p.x*.038+sin(p.z*.027)*2.);float far=smoothstep(90.,300.,distance(camera,p));vec3 grass=cover.rgb*clamp(surface/max(mean,vec3(.012)),vec3(.35),vec3(2.4));meadow=mix(meadow,grass,mix(cover.a*.45,smoothstep(0.,.52,cover.a),far));vec3 base=mix(mix(mix(meadow*macroTint,soil,wear),stone,rock*(1.-wear))*(1.-land.b*.12),forestFloor*macroTint,woodland*(1.-smoothstep(.08,.45,land.g)));return mix(base,mix(soil*.58,stone*.84,bank.y)*macroTint,bank.x*(1.-smoothstep(.3,.85,land.g)));}`,
  `fn groundBlend(p:vec3f,camera:vec3f,land:vec4f,soil:vec3f,lush:vec3f,dry:vec3f,stone:vec3f,root:f32,bank:vec2f,cover:vec4f,surface:vec3f,mean:vec3f,forestFloor:vec3f,woodland:f32)->vec3f{var meadow=mix(dry,lush,smoothstep(.22,.64,land.b));let wear=max(smoothstep(.08,.72,land.g),smoothstep(.08,.65,root)*.92);let rock=smoothstep(.32,.72,land.a);let macroTint=.90+.10*sin(p.x*.038+sin(p.z*.027)*2.);let far=smoothstep(90.,300.,distance(camera,p));let grass=cover.rgb*clamp(surface/max(mean,vec3f(.012)),vec3f(.35),vec3f(2.4));meadow=mix(meadow,grass,mix(cover.a*.45,smoothstep(0.,.52,cover.a),far));let base=mix(mix(mix(meadow*macroTint,soil,wear),stone,rock*(1.-wear))*(1.-land.b*.12),forestFloor*macroTint,woodland*(1.-smoothstep(.08,.45,land.g)));return mix(base,mix(soil*.58,stone*.84,bank.y)*macroTint,bank.x*(1.-smoothstep(.3,.85,land.g)));}`,
);
export const sampleAtlas = nativeFunction(
  `vec4 sampleAtlas(sampler2D map,vec3 p,vec3 origin,vec3 extent,vec3 dims,vec4 fallback,float flipY){vec3 local=(p-origin)/extent;if(any(lessThan(local,vec3(0.)))||any(greaterThan(local,vec3(1.))))return fallback;vec3 c=clamp(local*dims-.5,vec3(0.),dims-1.);float y=floor(c.y);vec2 a=vec2((c.x+.5)/dims.x,(c.z+.5+y*dims.z)/(dims.z*dims.y));vec2 b=vec2(a.x,(c.z+.5+min(y+1.,dims.y-1.)*dims.z)/(dims.z*dims.y));vec3 edge=min(local,1.-local)*extent;float weight=smoothstep(0.,24.,min(edge.x,edge.z))*smoothstep(0.,6.,edge.y);return mix(fallback,mix(textureLod(map,a,0.),textureLod(map,b,0.),fract(c.y)),weight);}`,
  `fn sampleAtlas(map:texture_2d<f32>,linearSampler:sampler,p:vec3f,origin:vec3f,extent:vec3f,dims:vec3f,fallback:vec4f,flipY:f32)->vec4f{let local=(p-origin)/extent;if(any(local<vec3f(0.))||any(local>vec3f(1.))){return fallback;}let c=clamp(local*dims-vec3f(.5),vec3f(0.),dims-vec3f(1.));let y=floor(c.y);var a=vec2f((c.x+.5)/dims.x,(c.z+.5+y*dims.z)/(dims.z*dims.y));var b=vec2f(a.x,(c.z+.5+min(y+1.,dims.y-1.)*dims.z)/(dims.z*dims.y));if(flipY>.5){a.y=1.-a.y;b.y=1.-b.y;}let edge=min(local,vec3f(1.)-local)*extent;let weight=smoothstep(0.,24.,min(edge.x,edge.z))*smoothstep(0.,6.,edge.y);return mix(fallback,mix(textureSampleLevel(map,linearSampler,a,0.),textureSampleLevel(map,linearSampler,b,0.),fract(c.y)),weight);}`,
);
export const normalKernel = nativeFunction(
  `vec4 normalKernel(sampler2D map,vec2 uv,vec2 texel,float strength){vec4 l=textureLod(map,uv-vec2(texel.x,0.),0.),r=textureLod(map,uv+vec2(texel.x,0.),0.),b=textureLod(map,uv-vec2(0.,texel.y),0.),t=textureLod(map,uv+vec2(0.,texel.y),0.);vec3 weights=vec3(.299,.587,.114);float dx=dot(r.rgb,weights)*r.a-dot(l.rgb,weights)*l.a,dy=dot(t.rgb,weights)*t.a-dot(b.rgb,weights)*b.a;return vec4(normalize(vec3(-dx*strength,-dy*strength,1.))*.5+.5,1.);}`,
  `fn normalKernel(map:texture_2d<f32>,linearSampler:sampler,uv:vec2f,texel:vec2f,strength:f32)->vec4f{let l=textureSampleLevel(map,linearSampler,uv-vec2f(texel.x,0.),0.);let r=textureSampleLevel(map,linearSampler,uv+vec2f(texel.x,0.),0.);let b=textureSampleLevel(map,linearSampler,uv-vec2f(0.,texel.y),0.);let t=textureSampleLevel(map,linearSampler,uv+vec2f(0.,texel.y),0.);let weights=vec3f(.299,.587,.114);let dx=dot(r.rgb,weights)*r.a-dot(l.rgb,weights)*l.a;let dy=dot(t.rgb,weights)*t.a-dot(b.rgb,weights)*b.a;return vec4f(normalize(vec3f(-dx*strength,-dy*strength,1.))*.5+vec3f(.5),1.);}`,
);
export const nativeVolumeSource = volumeGLSL + volumeWGSL;

export const skyColour = nativeFunction(
  `vec3 skyColour(vec3 ray,vec3 sun,vec4 cloud,float daylight){
 float altitude=pow(max(ray.y,0.),.42),toward=max(dot(ray,sun),0.);
 vec3 sky=mix(vec3(.40,.60,.82),vec3(.045,.20,.53),altitude);
 float dusk=1.-smoothstep(.02,.30,sun.y);
 sky=mix(sky,mix(vec3(.85,.43,.20),sky,smoothstep(0.,.5,ray.y)),dusk*.65);
 sky+=vec3(1.,.76,.42)*(pow(toward,256.)*.26+pow(toward,24.)*.035);
 vec3 cloudLight=mix(cloud.rgb,cloud.rgb*vec3(1.,.74,.52),dusk*.55);
 return mix(mix(vec3(.006,.012,.028),vec3(.025,.032,.045),cloud.a),sky*(1.-cloud.a)+cloudLight,daylight);
}`,
  `fn skyColour(ray:vec3f,sun:vec3f,cloud:vec4f,daylight:f32)->vec3f{
 let altitude=pow(max(ray.y,0.),.42);let toward=max(dot(ray,sun),0.);
 var sky=mix(vec3f(.40,.60,.82),vec3f(.045,.20,.53),altitude);
 let dusk=1.-smoothstep(.02,.30,sun.y);
 sky=mix(sky,mix(vec3f(.85,.43,.20),sky,smoothstep(0.,.5,ray.y)),dusk*.65);
 sky+=vec3f(1.,.76,.42)*(pow(toward,256.)*.26+pow(toward,24.)*.035);
 let cloudLight=mix(cloud.rgb,cloud.rgb*vec3f(1.,.74,.52),dusk*.55);
 return mix(mix(vec3f(.006,.012,.028),vec3f(.025,.032,.045),cloud.a),sky*(1.-cloud.a)+cloudLight,daylight);
}`,
);

// Moss has its own linear reflectance rather than multiplying green into dark bark.
// Irregular age masks are baked per vertex; moisture and stable exposure govern coverage.
export const mossSurface = nativeFunction(
  `vec3 mossSurface(vec3 bark,float coverage,vec3 n,vec2 habitat){float exposure=.5*(max(dot(n,vec3(-.55,.70,-.44)),0.)+max(dot(n,vec3(.55,.70,.44)),0.))+.4*max(n.y,0.);float shelter=1.-clamp(exposure*(1.-habitat.y*.88),0.,1.);float climate=smoothstep(.12,.65,habitat.x)*(.08+.92*pow(shelter,3.));float fine=clamp(dot(bark,vec3(.2126,.7152,.0722))*3.,0.,1.);float mask=clamp(coverage*climate,0.,1.);return mix(bark,mix(vec3(.022,.047,.006),vec3(.075,.13,.017),fine),mask);}`,
  `fn mossSurface(bark:vec3f,coverage:f32,n:vec3f,habitat:vec2f)->vec3f{let exposure=.5*(max(dot(n,vec3f(-.55,.70,-.44)),0.)+max(dot(n,vec3f(.55,.70,.44)),0.))+.4*max(n.y,0.);let shelter=1.-clamp(exposure*(1.-habitat.y*.88),0.,1.);let climate=smoothstep(.12,.65,habitat.x)*(.08+.92*pow(shelter,3.));let fine=clamp(dot(bark,vec3f(.2126,.7152,.0722))*3.,0.,1.);let mask=clamp(coverage*climate,0.,1.);return mix(bark,mix(vec3f(.022,.047,.006),vec3f(.075,.13,.017),fine),mask);}`,
);
