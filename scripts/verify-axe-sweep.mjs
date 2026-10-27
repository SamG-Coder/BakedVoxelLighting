import assert from 'node:assert/strict';
import * as T from 'three/webgpu';
import {AxeSweep,SWING_SECONDS} from '../src/axe-sweep.js';
import {WalkCollision} from '../src/walk-collision.js';
const geometry=new T.CylinderGeometry(.26,.26,4,24);geometry.translate(0,2,0);
const prototypes=[{high:geometry,paths:[{rootFlare:true,points:[new T.Vector3(0,0,0),new T.Vector3(0,4,0)],radii:[.26,.26]}]}];
function run(x,fps=60) {
 const trees=[{x,y:0,z:-1.38,rotation:0,scale:1,variant:0}];
 const camera=new T.PerspectiveCamera();camera.position.set(0,1.4,0);camera.lookAt(0,1.15,-1.5);camera.updateMatrixWorld();
 const sweep=new AxeSweep();sweep.begin(camera,new WalkCollision(trees,prototypes),trees);
 let contact;
 while(sweep.elapsed<.52&&sweep.active){contact=sweep.advance(1/fps,trees,prototypes,new Map());if(contact)break;}
 return {contact,sweep,camera};
}
for(const x of [-.3,0,.3]) {
 const normal=run(x,60),slow=run(x,20),fast=run(x,180);
 assert(normal.contact,`offset ${x} contacts actual trunk`);
 assert(slow.contact&&fast.contact);
 assert(normal.contact.point.distanceTo(slow.contact.point)<.008);
 assert(normal.contact.point.distanceTo(fast.contact.point)<.008);
 assert(Math.abs(Math.hypot(normal.contact.point.x-x,normal.contact.point.z+1.38)-.26)<.008);
 console.log('offset',x,'contact',normal.contact.point.toArray().map(v=>+v.toFixed(3)),'at',normal.contact.time.toFixed(3));
 const axe=new T.Group();normal.camera.add(axe);normal.sweep.pose(axe,normal.camera,normal.contact.time);normal.camera.updateMatrixWorld(true);
 assert(axe.position.toArray().every(Number.isFinite));
}
assert(!run(3).contact,'no remote damage');
const missed=run(3);assert(missed.sweep.elapsed<SWING_SECONDS);
console.log('Actual edge sweeps: left/centre/right, 20/60/180 Hz agreement and misses passed.');
