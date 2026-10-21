// Focused CPU-port regressions. Display/GPU execution is unnecessary here.
const assert=require('node:assert/strict');const {test}=require('node:test');
require('@angular/compiler');process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'commonjs',moduleResolution:'node',target:'es2020'});require('ts-node/register/transpile-only');
const {TMS9918A}=require('../src/app/emulator/classes/tms9918a.ts');const {F18A}=require('../src/app/emulator/classes/f18a.ts');
function ports(Type){return Object.assign(Object.create(Type.prototype),{ram:new Uint8Array(65536),registers:new Uint8Array(64),ramMask:0x3fff,addressRegister:0,addressIncrement:1,prefetchByte:0,latch:false,unlocked:false,dataPortMode:false,log:{info(){}}});}
function address(v,a){v.writeAddress(a&255);v.writeAddress(a>>8);}
for(const Type of [TMS9918A,F18A]){
 test(Type.name+': data writes refresh the read buffer used by TELCO video detection',()=>{
  const v=ports(Type);v.ram[0]=0x34;address(v,0);const previous=v.readData();
  address(v,0x4000);v.writeData(previous^255);address(v,0x8e00);
  // No read-address setup here: the first read must return the last write.
  assert.equal(v.readData(),previous^255);
 });
 test(Type.name+': write wrap and subsequent read-address prefetch stay correct',()=>{
  const v=ports(Type);v.ram[0]=0x56;v.ram[1]=0x78;
  address(v,0x7fff);v.writeData(0xa5);assert.equal(v.ram[0x3fff],0xa5);
  assert.equal(v.readData(),0xa5);assert.equal(v.readData(),0x56);
  address(v,1);assert.equal(v.readData(),0x78);
 });
}
