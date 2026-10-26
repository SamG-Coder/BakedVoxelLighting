vec4 volumeBake(vec2 uv, vec3 dims, vec3 origin, vec3 extent, sampler2D terrain, sampler2D trees, sampler3D details, sampler3D field, sampler2D transportMap, float grid, int mode, float directionMode, vec3 sun, vec3 sunColour, vec3 lamp, float power) {
    vec2 pixel=floor(uv*vec2(dims.x,dims.y*dims.z));
    vec3 cell=vec3(pixel.x,floor(pixel.y/dims.z),mod(pixel.y,dims.z));
    vec3 p=origin+(cell+.5)/dims*extent;
    if(mode==0) {
        vec2 c=clamp((p.xz+2000.)/4000.*(grid-1.),0.,grid-1.);
        ivec2 b=ivec2(floor(c)); vec2 f=fract(c); ivec2 hi=ivec2(int(grid)-1);
        vec4 land=mix(mix(texelFetch(terrain,b,0),texelFetch(terrain,min(b+ivec2(1,0),hi),0),f.x),mix(texelFetch(terrain,min(b+ivec2(0,1),hi),0),texelFetch(terrain,min(b+ivec2(1),hi),0),f.x),f.y);
        vec3 color=mix(vec3(.17,.25,.065),vec3(.25,.18,.11),land.g);
        float a=clamp((land.r-(p.y-.5*extent.y/dims.y))/(extent.y/dims.y),0.,1.);
        vec4 header=texelFetch(trees,ivec2(cell.x,cell.z),0);
        for(int i=0;i<int(header.y);i++) {
            int index=int(header.x)+i,width=int(dims.x);
            vec4 tree=texelFetch(trees,ivec2(index%width,index/width),0);vec3 q=p-tree.xyz;
            if(length(q.xz)<tree.w*.42&&q.y>0.&&q.y<tree.w*8.){a=1.;color=vec3(.24,.17,.09);}
        }
        vec4 extra=textureLod(details,(p-origin)/extent,0.);
        float merged=1.-(1.-a)*(1.-extra.a);
        return vec4(mix(color,extra.rgb,extra.a/max(merged,.001)),merged);
    }
    float stepSize=extent.x/dims.x;
    if(mode==1) {
        vec3 bounce=vec3(0.),incoming=vec3(0.);float sky=0.;
        for(int i=0;i<12;i++) {
            float y=.08+float(i)*.076,phi=float(i)*2.399963;
            vec3 dir=vec3(cos(phi)*sqrt(1.-y*y),y,sin(phi)*sqrt(1.-y*y));float tr=1.;
            for(int j=1;j<=20;j++) {
                vec3 q=(p+dir*float(j)*stepSize-origin)/extent;vec4 hit=vec4(0.);
                if(all(greaterThanEqual(q,vec3(0.)))&&all(lessThanEqual(q,vec3(1.))))hit=textureLod(field,q,0.);
                bounce+=hit.rgb*tr*hit.a*(.12/12.);tr*=1.-hit.a*.9;if(tr<.02)break;
            }
            sky+=tr/12.;incoming+=dir*tr;
        }
        vec3 bent=length(incoming)>.001?normalize(incoming):vec3(0.,1.,0.);
        return vec4(directionMode>.5?bent*.5+.5:bounce,sky);
    }
    vec3 ld=lamp-p;float dist=length(ld);vec3 lampDir=ld/max(dist,.0001);vec2 visibility=vec2(1.);
    for(int ray=0;ray<2;ray++) {
        vec3 dir=ray==0?sun:lampDir;vec3 start=p+dir*(ray==0?stepSize*.5:1.2);
        float limit=ray==0?150.:dist,tr=1.;
        for(int j=1;j<=28;j++) {
            float t=float(j)*stepSize*.65;if(t>limit)break;
            vec3 q=(start+dir*t-origin)/extent;float alpha=0.;
            if(all(greaterThanEqual(q,vec3(0.)))&&all(lessThanEqual(q,vec3(1.))))alpha=textureLod(field,q,0.).a;
            tr*=1.-alpha*.9;if(tr<.02)break;
        }
        visibility[ray]=tr;
    }
    vec4 transport=textureLod(transportMap,uv,0.);
    vec3 indirect=vec3(.035,.055,.085)*(.15+transport.a*.85)+transport.rgb*sunColour*.8+vec3(1.,.43,.12)*power/(10.+dist*dist)*visibility.y*.14;
    return vec4(indirect,visibility.x);
}
