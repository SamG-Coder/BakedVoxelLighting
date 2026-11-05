import { nativeFunction } from "./native-kernels.js";
import densityWGSL from "./shaders/cloud-density.wgsl?raw";
export const cloudShape = nativeFunction(densityWGSL);
export const cloudSample =
  nativeFunction(`fn cloudSample(map:texture_2d<f32>,linearSampler:sampler,p:vec3f,flipY:f32)->vec4f{
    if(p.y<0.||p.y>1.){return vec4f(0.);}
    let y=clamp(p.y*48.-.5,0.,47.);let a=floor(y);let b=min(a+1.,47.);
    let pixel=fract(p.xz)*255.+vec2f(.5);
    var ua=(pixel+vec2f(a-floor(a/8.)*8.,floor(a/8.))*256.)/vec2f(2048.,1536.);
    var ub=(pixel+vec2f(b-floor(b/8.)*8.,floor(b/8.))*256.)/vec2f(2048.,1536.);
    if(flipY>.5){ua.y=1.-ua.y;ub.y=1.-ub.y;}
    return mix(textureSampleLevel(map,linearSampler,ua,0.),textureSampleLevel(map,linearSampler,ub,0.),fract(y));
  }`);
export const cloudLighting = nativeFunction(
  `fn cloudLighting(map:texture_2d<f32>,linearSampler:sampler,p:vec3f,sun:vec3f,flipY:f32)->vec4f{
    let density=cloudSample(map,linearSampler,p,flipY).r;var depth=0.;
    if(density<.002){return vec4f(0.,1.,p.y,1.);}
    for(var i:i32=1;i<=7;i++){depth+=cloudSample(map,linearSampler,p+sun*f32(i)*75./vec3f(6000.,620.,6000.),flipY).r;}
    return vec4f(density,exp(-depth*.64),p.y,1.);
  }`,
  [cloudSample],
);
// Henyey-Greenstein phase for forward/back scattering in cloud droplets.
export const cloudPhase = nativeFunction(`fn cloudPhase(cosine:f32,g:f32)->f32{
    let g2=g*g;return (1.-g2)/(12.566371*pow(max(1.+g2-2.*g*cosine,1e-4),1.5));
  }`);
// Small periodic value noise used to erode the baked density into crisp,
// cauliflower-like edges at a resolution the 23 m bake cannot hold.
export const cloudDetail = nativeFunction(`fn cloudDetail(p:vec3f)->f32{
    var v=p;var sum=0.;var amp=.55;
    for(var o:i32=0;o<3;o++){
      let c=floor(v);var f=fract(v);f=f*f*(vec3f(3.)-2.*f);var value=0.;
      for(var z:i32=0;z<2;z++){for(var y:i32=0;y<2;y++){for(var x:i32=0;x<2;x++){
        let q=vec3f(f32(x),f32(y),f32(z));
        let h=fract(sin(dot(c+q,vec3f(127.1,311.7,74.7)))*43758.5453);
        let w=mix(vec3f(1.)-f,f,q);value+=h*w.x*w.y*w.z;
      }}}
      sum+=value*amp;amp*=.5;v=v*2.07+vec3f(17.,3.,9.);
    }
    return sum;
  }`);
export const cloudTrace = nativeFunction(
  `fn cloudTrace(map:texture_2d<f32>,linearSampler:sampler,eye:vec3f,ray:vec3f,sun:vec3f,time:f32,flipY:f32)->vec4f{
    if(ray.y<.025){return vec4f(0.);}
    let start=max(0.,(650.-eye.y)/ray.y);let end=min(11000.,(1270.-eye.y)/ray.y);
    if(end<=start){return vec4f(0.);}
    let stepSize=(end-start)/64.;var tr=1.;var colour=vec3f(0.);
    // Dual-lobe phase: strong forward peak (silver lining) plus back-scatter.
    let cosine=dot(ray,sun);
    let phase=mix(cloudPhase(cosine,.62),cloudPhase(cosine,-.22),.3)*12.566371;
    let jitter=fract(sin(dot(ray.xz,vec2f(127.1,311.7)))*43758.5453);
    for(var i:i32=0;i<64;i++){
      var p=eye+ray*(start+(f32(i)+fract(jitter+f32(i)*.618))*stepSize);
      p+=vec3f(2.,0.,.6)*time;
      let c=cloudSample(map,linearSampler,(p-vec3f(0.,650.,0.))/vec3f(6000.,620.,6000.),flipY);
      if(c.r<.004){continue;}
      // Erode the soft baked shape: crisp billows, wispy thin edges.
      let detail=cloudDetail(p*vec3f(1./34.,1./24.,1./34.)+vec3f(0.,time*.004,0.));
      // Billows everywhere (not only the fringe), wisps where the bake is thin.
      let d=max(0.,c.r*1.6-detail*.62-(1.-min(c.r*1.6,1.))*detail*.8);
      if(d<=0.){continue;}
      let a=1.-exp(-d*stepSize*.009);
      // Height ambient: grey-blue bases, bright tops.
      let h=c.b;
      let ambient=mix(vec3f(.12,.15,.21),vec3f(.44,.52,.66),pow(h,1.6));
      // Beer-powder: interiors facing the sun are darker at the edges.
      let powder=1.-exp(-d*1.8);
      let sunBeer=c.g;
      let direct=vec3f(1.,.95,.86)*sunBeer*mix(.55,1.,powder)*phase*.62;
      // Cheap multiple scattering: light leaks deeper than single scattering.
      let multi=vec3f(1.,.96,.9)*pow(sunBeer,.25)*.12;
      colour+=tr*a*(ambient+direct+multi);tr*=1.-a;if(tr<.015){break;}
    }
    let fade=smoothstep(.025,.075,ray.y);
    return vec4f(colour*fade,(1.-tr)*fade);
  }`,
  [cloudSample, cloudPhase, cloudDetail],
);
export const cloudShadow = nativeFunction(
  `fn cloudShadow(map:texture_2d<f32>,linearSampler:sampler,world:vec2f,sun:vec3f,time:f32,flipY:f32)->f32{
    if(sun.y<.035){return 0.;}var depth=0.;
    for(var i:i32=0;i<16;i++){
      let h=(f32(i)+.5)/16.;let xz=world+sun.xz*(650.+h*620.)/sun.y+vec2f(2.,.6)*time;
      depth+=cloudSample(map,linearSampler,vec3f(xz.x/6000.,h,xz.y/6000.),flipY).r;
    }
    return 1.-exp(-depth*.18/max(sun.y,.2));
  }`,
  [cloudSample],
);
