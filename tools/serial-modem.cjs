// Small Hayes-style serial modem. Independent of the cartridge mapper.
// Telnet framing follows RFC 854/856; this is not a Wi-Fi firmware emulator.
const net = require('node:net');
class Telnet {
  constructor(send, receive) { this.send=send; this.receive=receive; this.state=0; this.local=new Set(); this.remote=new Set(); this.cr=false; }
  negotiation(command, option) {
    const enabling=command===251||command===253;
    const remote=command===251||command===252;
    const enabled=remote?this.remote:this.local;
    const accept=remote?[0,1,3].includes(option):[0,3].includes(option);
    const yes=remote?253:251, no=remote?254:252;
    if(enabling) { if(accept) {if(!enabled.has(option)){enabled.add(option);this.send(Buffer.from([255,yes,option]));}} else this.send(Buffer.from([255,no,option])); }
    else if(enabled.delete(option)) this.send(Buffer.from([255,no,option]));
  }
  input(data) {
    const out=[];
    for(const b of data) {
      if(this.state===0) { if(b===255)this.state=1; else {if(!(this.cr&&b===0&&!this.remote.has(0)))out.push(b);this.cr=b===13;} }
      else if(this.state===1) { if(b===255){out.push(255);this.state=0;this.cr=false;} else if(b>=251&&b<=254){this.command=b;this.state=2;} else this.state=b===250?3:0; }
      else if(this.state===2){this.negotiation(this.command,b);this.state=0;}
      else if(this.state===3){if(b===255)this.state=4;}
      else this.state=b===240?0:3;
    }
    if(out.length)this.receive(Buffer.from(out));
  }
  output(data) {
    const out=[];
    for(const b of data){out.push(b);if(b===255)out.push(255);else if(b===13&&!this.local.has(0))out.push(0);}
    this.send(Buffer.from(out));
  }
}
class Modem {
  constructor(receive,{guard=1000,connect=net.createConnection}={}) {
    this.receive=receive;this.guard=guard;this.connect=connect;this.line='';this.echo=true;this.command=true;this.last=0;this.plus=[];this.baud=1200;this.closed=false;
  }
  result(text){this.receive(Buffer.from('\r\n'+text+'\r\n'));}
  configure(s){if(Number.isFinite(s.baud)&&s.baud>0)this.baud=s.baud;}
  input(data){for(const b of data)this.byte(b);}
  byte(b){
    const now=Date.now();
    if(this.dialing){this.hangup();this.result('NO CARRIER');return;}
    if(!this.command){
      if(this.plus.length){
        clearTimeout(this.escapeTimer);
        if(b===43&&this.plus.length<3){this.plus.push(b);this.escapeTimer=setTimeout(()=>this.escape(),this.guard);}
        else {this.network(Buffer.from(this.plus));this.plus=[];this.network(Buffer.from([b]));}
      } else if(b===43&&now-this.last>=this.guard){this.plus=[b];this.escapeTimer=setTimeout(()=>this.escape(),this.guard);}
      else this.network(Buffer.from([b]));
      this.last=now;return;
    }
    // Terminals send flow-control bytes around their settings menus. They
    // are not command text: echoing XOFF back can pause the terminal itself.
    // Online mode above still carries every byte, including binary transfers.
    if(b<32&&b!==8&&b!==13)return;
    if(this.echo)this.receive(Buffer.from([b]));
    if(b===13){const line=this.line;this.line='';this.execute(line);}
    else if(b===8||b===127)this.line=this.line.slice(0,-1);
    else if(b>=32&&b<127){if(this.line.length<512)this.line+=String.fromCharCode(b);else{this.line='';this.result('ERROR');}}
  }
  escape(){if(this.plus.length===3){this.plus=[];this.command=true;this.result('OK');}else{this.network(Buffer.from(this.plus));this.plus=[];}}
  execute(line){
    const match=/^AT(.*)$/i.exec(line.trim());if(!match){if(line.trim())this.result('ERROR');return;}
    const cmd=match[1].trim(), upper=cmd.toUpperCase();
    if(!cmd)return this.result('OK');
    if(upper==='I')return this.result('JS99ER SERIAL MODEM\r\nOK');
    if(upper==='H'||upper==='H0'){this.hangup();return this.result('OK');}
    if(upper==='Z'||upper==='&F'){this.hangup();this.echo=true;return this.result('OK');}
    if(/^E[01]$/.test(upper)){this.echo=upper==='E1';return this.result('OK');}
    if(upper==='O'||upper==='O0'){if(!this.socket)return this.result('NO CARRIER');this.command=false;this.last=Date.now();return this.result('CONNECT '+Math.round(this.baud));}
    if(/^DT?/i.test(cmd))return this.dial(cmd.replace(/^DT?/i,''));
    this.result('ERROR');
  }
  dial(target){
    target=target.trim();
    if(this.socket)return this.result('ERROR');
    let raw=false;if(/^tcp:\/\//i.test(target)){raw=true;target=target.slice(6);}else target=target.replace(/^telnet:\/\//i,'');
    const m=/^(\[[0-9a-f:]+\]|[a-z0-9._-]+)(?::([0-9]+))?$/i.exec(target);
    const port=m?Number(m[2]||23):0;if(!m||port<1||port>65535)return this.result('ERROR');
    this.dialing=true;
    const socket=this.socket=this.connect({host:m[1].replace(/^\[|\]$/g,''),port});
    this.telnet=raw?null:new Telnet(b=>socket.write(b),b=>this.receive(b));
    const timeout=setTimeout(()=>socket.destroy(),10000);
    socket.once('connect',()=>{clearTimeout(timeout);if(this.socket!==socket)return;this.dialing=false;this.command=false;this.last=Date.now();this.result('CONNECT '+Math.round(this.baud));});
    socket.on('data',b=>{if(this.socket===socket){if(this.telnet)this.telnet.input(b);else this.receive(b);}});
    socket.on('error',()=>{});
    socket.once('close',()=>{clearTimeout(timeout);if(this.socket!==socket)return;this.socket=null;this.dialing=false;this.command=true;clearTimeout(this.escapeTimer);this.plus=[];if(!this.closed)this.result('NO CARRIER');});
  }
  network(b){if(this.socket){if(this.telnet)this.telnet.output(b);else this.socket.write(b);}}
  hangup(){clearTimeout(this.escapeTimer);this.plus=[];const s=this.socket;this.socket=null;this.dialing=false;this.command=true;s?.destroy();}
  close(){this.closed=true;this.hangup();}
}
module.exports={Modem,Telnet};
