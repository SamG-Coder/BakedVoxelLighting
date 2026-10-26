import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await page.goto('http://127.0.0.1:5173');await page.waitForFunction(()=>worldDiagnostics.ready&&!worldDiagnostics.baking,null,{timeout:180000});
 await page.waitForFunction(()=>worldDiagnostics.mergedVisibility?.baked>80,null,{timeout:60000});
 await page.waitForTimeout(3000);
 const cold=await page.evaluate(()=>{const w=worldTest,merged=w.clusters.filter(c=>c.farMerged);return {stats:structuredClone(worldDiagnostics.mergedVisibility),draws:worldDiagnostics.drawCalls,fps:worldDiagnostics.fps,meshCount:merged.length,valid:merged.every(c=>c.levels[3].children.length===1&&!c.levels[3].children[0].isInstancedMesh&&c.levels[3].children[0].geometry.attributes.position.count===c.trees.length*4),unbuilt:w.clusters.filter(c=>!c.farMerged).length};});assert.ok(cold.valid);assert.ok(cold.unbuilt>0);assert.ok(cold.stats.sourceDraws>cold.stats.mergedDraws*3);assert.deepEqual(cold.stats.errors,[]);
 await page.evaluate(()=>{document.body.classList.add('exploring');document.querySelector('aside').style.display='none';});await page.screenshot({path:'evidence/visibility-merged.png'});
 await page.reload();await page.waitForFunction(()=>worldDiagnostics.ready&&worldDiagnostics.mergedVisibility?.hits>50,null,{timeout:180000});
 const warm=await page.evaluate(()=>structuredClone(worldDiagnostics.mergedVisibility));assert.ok(warm.hits>50);assert.deepEqual(errors,[]);
 // Newly viewed regions must still generate meshes; the first camera must not permanently erase them.
 await page.evaluate(()=>{const w=worldTest;w.controls.target.set(w.camera.position.x,w.camera.position.y,w.camera.position.z+100);w.controls.update();});await page.waitForTimeout(3500);
 const turned=await page.evaluate(()=>structuredClone(worldDiagnostics.mergedVisibility));assert.ok(turned.baked>warm.baked);assert.deepEqual(turned.errors,[]);
 await writeFile('evidence/merged-visibility.json',JSON.stringify({cold,warm,turned,errors},null,2));console.log(JSON.stringify({cold,warm,turned,errors},null,2));
}finally{await browser.close();}
