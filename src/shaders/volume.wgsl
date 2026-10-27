fn volumeBake(uv: vec2f, dims: vec3f, origin: vec3f, extent: vec3f, terrain: texture_2d<f32>, trees: texture_2d<f32>, details: texture_3d<f32>, field: texture_3d<f32>, transportMap: texture_2d<f32>, linearSampler: sampler, grid: f32, mode: i32, directionMode: f32, sun: vec3f, daylight: f32, sunColour: vec3f, lampColour: vec3f, lamp: vec3f, power: f32) -> vec4f {
    let pixel=floor(uv*vec2f(dims.x,dims.y*dims.z));
    let cell=vec3f(pixel.x,floor(pixel.y/dims.z),pixel.y-floor(pixel.y/dims.z)*dims.z);
    let p=origin+(cell+vec3f(.5))/dims*extent;
    if(mode==0) {
        let c=clamp((p.xz+vec2f(2000.))/4000.*(grid-1.),vec2f(0.),vec2f(grid-1.));
        let b=vec2i(floor(c));let f=fract(c);let hi=vec2i(i32(grid)-1);
        let land=mix(mix(textureLoad(terrain,b,0),textureLoad(terrain,min(b+vec2i(1,0),hi),0),f.x),mix(textureLoad(terrain,min(b+vec2i(0,1),hi),0),textureLoad(terrain,min(b+vec2i(1),hi),0),f.x),f.y);
        var color=mix(vec3f(.17,.25,.065),vec3f(.25,.18,.11),land.g);
        var a=clamp((land.r-(p.y-.5*extent.y/dims.y))/(extent.y/dims.y),0.,1.);
        let header=textureLoad(trees,vec2i(cell.xz),0);
        for(var i=0;i<i32(header.y);i++) {
            let index=i32(header.x)+i;let width=i32(dims.x);
            let tree=textureLoad(trees,vec2i(index%width,index/width),0);let q=p-tree.xyz;
            if(length(q.xz)<tree.w*.42&&q.y>0.&&q.y<tree.w*8.){a=1.;color=vec3f(.24,.17,.09);}
        }
        let extra=textureSampleLevel(details,linearSampler,(p-origin)/extent,0.);
        let merged=1.-(1.-a)*(1.-extra.a);
        return vec4f(mix(color,extra.rgb,extra.a/max(merged,.001)),merged);
    }
    let stepSize=extent.x/dims.x;
    if(mode==1) {
        var bounce=vec3f(0.);var incoming=vec3f(0.);var sky=0.;
        for(var i=0;i<12;i++) {
            let y=.08+f32(i)*.076;let phi=f32(i)*2.399963;
            let dir=vec3f(cos(phi)*sqrt(1.-y*y),y,sin(phi)*sqrt(1.-y*y));var tr=1.;
            for(var j=1;j<=20;j++) {
                let q=(p+dir*f32(j)*stepSize-origin)/extent;var hit=vec4f(0.);
                if(all(q>=vec3f(0.))&&all(q<=vec3f(1.))){hit=textureSampleLevel(field,linearSampler,q,0.);}
                bounce+=hit.rgb*tr*hit.a*(.12/12.);tr*=1.-hit.a*.9;if(tr<.02){break;}
            }
            sky+=tr/12.;incoming+=dir*tr;
        }
        var bent=vec3f(0.,1.,0.);if(length(incoming)>.001){bent=normalize(incoming);}
        var rgb=bounce;
        if(directionMode>.5){rgb=bent*.5+vec3f(.5);}
        return vec4f(rgb,sky);
    }
    let ld=lamp-p;let dist=length(ld);let lampDir=ld/max(dist,.0001);var visibility=vec2f(1.);
    for(var ray=0;ray<2;ray++) {
        let dir=select(lampDir,sun,ray==0);let start=p+dir*select(1.2,stepSize*.5,ray==0);
        let limit=select(dist,150.,ray==0);var tr=1.;
        for(var j=1;j<=28;j++) {
            let t=f32(j)*stepSize*.65;if(t>limit){break;}
            let q=(start+dir*t-origin)/extent;var alpha=0.;
            if(all(q>=vec3f(0.))&&all(q<=vec3f(1.))){alpha=textureSampleLevel(field,linearSampler,q,0.).a;}
            tr*=1.-alpha*.9;if(tr<.02){break;}
        }
        visibility[ray]=tr;
    }
    let transport=textureSampleLevel(transportMap,linearSampler,uv,0.);
    let indirect=(vec3f(.085,.115,.16)*(.15+transport.a*.85)+transport.rgb*sunColour*.8)*daylight+(vec3f(.035,.055,.085)*(.15+transport.a*.85)+transport.rgb*sunColour*.8)*(.04*(1.-daylight))+lampColour*power/(10.+dist*dist)*visibility.y*.14;
    return vec4f(indirect,visibility.x);
}
