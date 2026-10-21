const assert=require('node:assert/strict'),{test}=require('node:test');
require('@angular/compiler');process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'commonjs',moduleResolution:'node',target:'es2020'});require('ts-node/register/transpile-only');
const {DiskImage}=require('../src/app/emulator/classes/disk-image.ts');
const {DiskFile,FixedRecord,VariableRecord}=require('../src/app/emulator/classes/disk-file.ts');
const {GenericFdc}=require('../src/app/emulator/classes/generic-fdc.ts');
const {DirectFileAccess}=require('../src/app/emulator/classes/direct-file-access.ts');
const {Log}=require('../src/app/classes/log.ts');Log.instance={info(){},warn(){},error(){},debug(){}};
function fixture(){const image=new DiskImage('TEST',null),pad=new Uint8Array(256),vram=new Uint8Array(16384);
 const memory={getPADByte:a=>pad[a&255],setPADByte:(a,b)=>pad[a&255]=b,getPADWord:a=>(pad[a&255]<<8)|pad[(a+1)&255],setPADWord:(a,w)=>{pad[a&255]=w>>8;pad[(a+1)&255]=w&255;}};
 const vdp={getByte:a=>vram[a&16383],setByte:(a,b)=>vram[a&16383]=b};
 const fdc=Object.assign(Object.create(GenericFdc.prototype),{memory,console:{getVDP:()=>vdp}}),drive={getDiskImage:()=>image};
 function call(write,name,count,first=0){vram.set(Buffer.from(name.padEnd(10)),0x100);memory.setPADWord(0x834c,0x100|count);memory.setPADWord(0x834e,0x100);memory.setPADByte(0x8350,0x60);memory.setPADWord(0x8360,0x2000);memory.setPADWord(0x8362,first);fdc[write?'fileOutput':'fileInput'](drive);return memory.getPADByte(0x8350);}
 return {image,memory,vram,call,pad};}
const sequence=n=>Uint8Array.from({length:n},(_,i)=>(i*73+(i>>8)*19)&255);
test('direct file write/read keeps raw sectors and unrelated files, including partial final sector',()=>{
 const f=fixture(),keep=new DiskFile('KEEP',1,0,0,0);keep.setProgram(sequence(301));f.image.putFile(keep);
 const before=f.image.getBinaryImage().slice();const old=DirectFileAccess.find(f.image,'KEEP');
 // Allocate 3 sectors, PROGRAM, EOF 17 (529 logical bytes).
 f.pad.set([0,3,1,0,17,0,0,0],0x62);assert.equal(f.call(true,'BINARY',0,3),0);
 const raw=sequence(768);f.vram.set(raw,0x2000);assert.equal(f.call(true,'BINARY',3),0);assert.equal(f.pad[0x4d],3);
 assert.deepEqual(f.image.getFile('BINARY').getProgram(),raw.subarray(0,529));
 f.vram.fill(0,0x2000,0x2300);assert.equal(f.call(false,'BINARY',3),0);assert.deepEqual(f.vram.subarray(0x2000,0x2300),raw);
 for(const sector of [old.fd/256,...old.sectors])assert.deepEqual(f.image.getBinaryImage().subarray(sector*256,(sector+1)*256),before.subarray(sector*256,(sector+1)*256));
 assert.equal(f.call(false,'BINARY',0),0);assert.equal(f.memory.getPADWord(0x8362),3);assert.equal(f.pad[0x66],17);
 assert.equal(f.call(false,'MISSING',1),0xe0);assert.equal(f.call(false,'BINARY',1,3),0xa0);
 assert.equal(f.call(false,'BINARY',4,1),0);assert.equal(f.pad[0x4d],2);
});
test('fixed and variable files survive TIFILES and DSK round trips with exact records',()=>{
 for(const variable of [false,true]){
  const d=new DiskImage('TEST',null),f=new DiskFile('RECORDS',0,variable?1:0,80,1);
  const expected=Array.from({length:7},(_,i)=>Array.from(sequence(variable?30+i*7:80),v=>(v+i)&255));
  f.open(1,0);for(const r of expected)f.putRecord(variable?new VariableRecord(r):new FixedRecord(r,80));d.putFile(f);
  const tfi=d.createTIFile('RECORDS');assert.equal(tfi.length,128+f.getSectorCount()*256);
  const a=new DiskImage('TFI',null);a.loadTIFile('RECORDS',tfi,false);
  const b=new DiskImage('DSK',null);b.loadBinaryImage(d.getBinaryImage());
  for(const out of [a,b])assert.deepEqual(out.getFile('RECORDS').getRecords().map(r=>r.getData()),expected);
 }
});
test('level-2 metadata includes both little-endian record-count bytes',()=>{
 const f=fixture(),info=Uint8Array.of(0,151,0,2,0,128,45,1);assert.equal(DirectFileAccess.create(f.image,'BIG',info),0);
 assert.equal(f.call(false,'BIG',0),0);assert.deepEqual(f.pad.subarray(0x62,0x6a),info);
 assert.equal(f.image.getFile('BIG').getRecordCount(),301);
});
test('allocation failures and write protection never mutate existing disk contents',()=>{
 const f=fixture();let bytes=f.image.getBinaryImage(),before=bytes.slice();
 assert.equal(DirectFileAccess.create(f.image,'HUGE',Uint8Array.of(255,255,1,0,0,0,0,0)),4);assert.deepEqual(f.image.getBinaryImage(),before);
 bytes[16]=0x50;before=bytes.slice();assert.equal(DirectFileAccess.create(f.image,'LOCKED',Uint8Array.of(0,1,1,0,0,0,0,0)),1);assert.deepEqual(f.image.getBinaryImage(),before);
});
test('fragmented allocation, replacement and empty program files remain readable',()=>{
 const f=fixture();for(let i=0;i<4;i++)assert.equal(DirectFileAccess.create(f.image,'F'+i,Uint8Array.of(0,2,1,0,0,0,0,0)),0);
 assert.equal(DirectFileAccess.create(f.image,'F0',Uint8Array.of(0,5,1,0,0,0,0,0)),0);
 const at=DirectFileAccess.find(f.image,'F0');assert.equal(at.sectors.length,5);assert.ok(at.sectors.some((v,i)=>i&&v!==at.sectors[i-1]+1));
 assert.equal(DirectFileAccess.create(f.image,'EMPTY',Uint8Array.of(0,0,1,0,0,0,0,0)),0);assert.equal(f.image.getFile('EMPTY').getProgram().length,0);
 const tfi=f.image.createTIFile('EMPTY'),copy=new DiskImage('COPY',null);assert.ok(copy.loadTIFile('EMPTY',tfi,false));
});


test('direct allocation supports two-sector allocation units',()=>{
 const f=fixture();f.image.physicalProperties.totalSectors=2880;f.image.invalidateBinaryImage();
 assert.equal(f.image.getSectorsPerAllocationUnit(),2);
 for(let i=0;i<3;i++)assert.equal(DirectFileAccess.create(f.image,'AU'+i,Uint8Array.of(0,3,1,0,0,0,0,0)),0);
 const sectors=[0,1];for(let i=0;i<3;i++){const file=DirectFileAccess.find(f.image,'AU'+i);assert.equal(file.sectors.length,3);sectors.push(file.fd/256,...file.sectors);}
 assert.equal(new Set(sectors).size,sectors.length);
 assert.equal(DirectFileAccess.create(f.image,'AU1',Uint8Array.of(0,7,1,0,0,0,0,0)),0);
 const raw=sequence(1792);f.vram.set(raw,0x2000);assert.equal(f.call(true,'AU1',7),0);assert.deepEqual(f.image.getFile('AU1').getProgram(),raw);
});
