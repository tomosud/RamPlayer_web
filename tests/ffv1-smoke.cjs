const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = process.argv[2] || process.env.FFV1_TEST_FILE;
if (!source) throw new Error('Supply a 24fps FFV1 MKV fixture of at least 4 seconds: npm run test:ffv1 -- path/to/file.mkv');
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8123';
fs.mkdirSync('.tmp/ffv1-probe', {recursive:true});
(async () => {
 const browser = await chromium.launch({ ...(process.env.TEST_BROWSER_PATH ? {executablePath:process.env.TEST_BROWSER_PATH} : process.platform==='win32' ? {channel:'msedge'} : {}), headless:true });
 try {
 const page = await browser.newPage();
 page.setDefaultTimeout(120000);
 await page.addInitScript(() => {
   window.decodeRequests = 0;
   const post = Worker.prototype.postMessage;
   Worker.prototype.postMessage = function(message, ...args) {
     if (message?.type === 'decode') window.decodeRequests++;
     return post.call(this, message, ...args);
   };
 });
 await page.route('https://**/*', route => route.abort());
 const errors=[]; page.on('pageerror', error=>errors.push(error.message));
 await page.goto(baseUrl);
 await page.evaluate(() => { const input=document.createElement('input');input.type='file';input.id='probeInput';document.body.append(input); });
 await page.locator('#probeInput').setInputFiles(source);
 const backendResult = await page.evaluate(async () => {
   const file=document.querySelector('#probeInput').files[0];
   const { openFallbackVideo } = await import('/src/media/VideoFrameSource.ts');
   const controller=new AbortController();
   const backend=await openFallbackVideo(file,controller.signal);
   const times=[]; const begin=performance.now();
   const wav=new Uint8Array(48);const view=new DataView(wav.buffer);const ascii=(offset,text)=>[...text].forEach((c,i)=>wav[offset+i]=c.charCodeAt(0));
   ascii(0,'RIFF');view.setUint32(4,40,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,4,true);
   const unsupported=await openFallbackVideo(new File([wav],'audio-only.mkv'),new AbortController().signal)===null;
   for await(const sample of backend.samples(0,0.85)){times.push(sample.timestamp);sample.close();}
   const seek=await backend.getSample(2);const seekTime=seek.timestamp;seek.close();
   const thumb=await backend.getSample(0);const canvas=document.createElement('canvas');canvas.width=backend.info.width;canvas.height=backend.info.height;thumb.draw(canvas.getContext('2d'),0,0);thumb.close();
   const nonBlack=canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data.slice(0,3).some(v=>v>0);
   const info={...backend.info};window.fixtureInfo=info;backend.dispose();
   const aborter=new AbortController();const opening=openFallbackVideo(file,aborter.signal);aborter.abort();let aborted=false;try{await opening;}catch(e){aborted=e.name==='AbortError';}
   return {times,seekTime,nonBlack,aborted,unsupported,info,elapsed:performance.now()-begin};
 });
 assert.equal(backendResult.times.length,21);
 backendResult.times.forEach((t,i)=>assert.ok(Math.abs(t-i/24)<0.0011,`PTS ${i}: ${t}`));
 assert.ok(Math.abs(backendResult.seekTime-2)<0.002);
 assert.ok(backendResult.nonBlack && backendResult.aborted && backendResult.unsupported);
 console.log('BACKEND',JSON.stringify(backendResult));
 const exportResult=await page.evaluate(async()=>{
   const file=document.querySelector('#probeInput').files[0];
   const {exportMp4Clip}=await import('/src/export/clipExport.ts');
   const {Input,BlobSource,ALL_FORMATS}=await import('/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
   const result=await exportMp4Clip({file,info:{name:file.name,duration:window.fixtureInfo.duration,width:window.fixtureInfo.width,height:window.fixtureInfo.height,fps:window.fixtureInfo.fps,hasAudio:false,videoBackend:'ffmpeg-ffv1'},inPoint:0,outPoint:0.25,bitrateScale:0.01});
   const input=new Input({source:new BlobSource(result.blob),formats:ALL_FORMATS});
   const track=await input.getPrimaryVideoTrack();window.nativeArtifact=result.blob;const resultInfo={size:result.blob.size,codec:await track.getCodec(),duration:await input.computeDuration()};input.dispose();return resultInfo;
 });
 assert.equal(exportResult.codec,'avc');assert.ok(Math.abs(exportResult.duration-0.25)<0.01);
 console.log('EXPORT',JSON.stringify(exportResult));
 await page.locator('#filePicker').setInputFiles(source);
 await page.waitForFunction(()=>!document.querySelector('#ramPreparation').hidden);
 assert.ok(await page.locator('#playPause').isDisabled());
 await page.waitForFunction(()=>document.querySelector('#mediaInfo').textContent.includes('RAM playback'), {}, {timeout:120000});
 const cachedDecodeRequests = await page.evaluate(()=>window.decodeRequests);
 await page.waitForFunction(()=>document.querySelector('#memUsage').textContent.includes('f)'));
 await page.locator('#nextFrame').click({force:true});
 await page.waitForFunction(()=>document.querySelector('#frameLabel').textContent.startsWith('Frame 1 /'));
 await page.locator('#prevFrame').click({force:true});
 await page.waitForFunction(()=>document.querySelector('#frameLabel').textContent.startsWith('Frame 0 /'));
 await page.locator('#playPause').click({force:true});
 await page.waitForFunction(()=>document.querySelector('#playPause').textContent==='Pause',{},{timeout:30000});
 await page.waitForTimeout(2500);
 await page.locator('#playPause').click({force:true});
 const current=await page.locator('#curTime').innerText();assert.ok(Number(current.split(':')[1]) >= 2, `RAM playback too slow: ${current}`);
 const box=await page.locator('#timeline').boundingBox();await page.mouse.click(box.x+box.width*0.65,box.y+box.height/2);
 await page.waitForTimeout(4000);
 assert.equal(await page.locator('#error').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.decodeRequests),cachedDecodeRequests, 'Playback/seek must not decode after preparation');
 console.log('UI',JSON.stringify({current,seek:await page.locator('#curTime').innerText(),errors}));
 // Switching back to a native clip must release the full RAM cache cleanly.
 await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(new File([window.nativeArtifact],'native.mp4',{type:'video/mp4'}));const picker=document.querySelector('#filePicker');picker.files=dt.files;picker.dispatchEvent(new Event('change'));});
 await page.waitForFunction(()=>document.querySelector('#totalTime').textContent==='00:00.250');
 await page.waitForTimeout(1000);
 assert.equal(await page.locator('#error').isVisible(),false);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'.tmp/ffv1-probe/integration.png'});
 fs.writeFileSync('.tmp/ffv1-probe/integration.json',JSON.stringify({backendResult,exportResult,current,errors},null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
