'use strict';
const $=s=>document.querySelector(s);
const COLORS=['#00f0ff','#ff3b5c','#ffd60a','#39ff88','#b36bff'];
const NAMES=['Ciano','Vermelho','Amarelo','Verde','Roxo'];
const RGB=COLORS.map(h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).join(','));
const FISH_C=['#4dffb0','#ff9d2e'];
/* teclas por jogador (e.code = independe do layout do teclado) */
const KEYMAPS=[
  {l:'KeyA',r:'KeyD',u:'KeyW',d:'KeyS',label:'W A S D'},
  {l:'ArrowLeft',r:'ArrowRight',u:'ArrowUp',d:'ArrowDown',label:'← ↑ ↓ →'},
  {l:'KeyJ',r:'KeyL',u:'KeyI',d:'KeyK',label:'I J K L'},
  {l:'KeyF',r:'KeyH',u:'KeyT',d:'KeyG',label:'T F G H'},
  {l:'Numpad4',r:'Numpad6',u:'Numpad8',d:'Numpad5',d2:'Numpad2',label:'Num 8 4 5 6'}
];
const GAME_CODES=new Set();KEYMAPS.forEach(m=>[m.l,m.r,m.u,m.d,m.d2].forEach(c=>c&&GAME_CODES.add(c)));
let W=360,H=640;const R=18,MAXP=5,GOAL=30; // GOAL = peixes para vencer
const DASH_CD=.15;   // intervalo entre mordidas/impulsos (s)
const DELAY=.1;      // atraso de suavização no cliente (s)
const SEND_DT=.04;   // anfitrião envia ~25 estados por segundo
const HUD_FONT='700 13px Orbitron, Rajdhani, monospace';

/* STUN + TURN: ajudam celular (4G/5G) e PC em redes diferentes a se conectarem */
const PEER_OPTS={config:{iceServers:[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:'stun:global.stun.twilio.com:3478'},
  {urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'],username:'openrelayproject',credential:'openrelayproject'}
]}};

const cv=$('#cv'),ctx=cv.getContext('2d'),stage=$('#stage');
let mode=null,sim=null,view=null,playing=false,inA=[],me=0,names=[],peer=null,conns=[],hostConn=null;
let running=false,raf=0,last=0,sendAcc=0,lastKey='-',lastSend=0;
const holds=new Map(),down=new Set(); // dedos/mouse em uso e teclas pressionadas
let snaps=[],rt=0,rtInit=false,lastMsg=0,rtt=null,pingTimer=null,joinTimer=null,wake=null,trails=[];
try{document.fonts&&document.fonts.load('700 13px Orbitron').catch(()=>{})}catch(e){}

/* ---------- Canvas responsivo (qualquer tamanho/densidade de tela) ---------- */
function fit(){
  const aw=stage.clientWidth,ah=stage.clientHeight;if(!aw||!ah)return;
  const sc=Math.min(aw/W,ah/H),cw=Math.max(1,Math.floor(W*sc)),ch=Math.max(1,Math.floor(H*sc));
  const d=Math.min(window.devicePixelRatio||1,2.5);
  cv.style.width=cw+'px';cv.style.height=ch+'px';
  cv.width=Math.round(cw*d);cv.height=Math.round(ch*d);
  ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0);
}
if('ResizeObserver' in window)new ResizeObserver(fit).observe(stage);
addEventListener('resize',fit);addEventListener('orientationchange',()=>setTimeout(fit,200));

/* ---------- Telas ---------- */
function show(id){document.querySelectorAll('.scr').forEach(e=>e.classList.add('hidden'));$('#'+id).classList.remove('hidden')}
function cleanup(){
  running=false;playing=false;cancelAnimationFrame(raf);
  clearInterval(pingTimer);clearTimeout(joinTimer);unlockScreen();
  if(peer)try{peer.destroy()}catch(e){}
  peer=null;conns=[];hostConn=null;sim=null;view=null;mode=null;names=[];snaps=[];inA=[];holds.clear();down.clear();rtt=null;
}
function toMenu(){cleanup();show('menu')}
document.querySelectorAll('[data-back]').forEach(b=>b.onclick=toMenu);
$('#btnExit').onclick=$('#btnMenu').onclick=toMenu;
$('#btnOnline').onclick=()=>{setSt('');show('online')};
$('#btnLocal').onclick=()=>show('local');
for(let n=1;n<=MAXP;n++){const b=document.createElement('button');b.textContent=n;b.onclick=()=>{cleanup();mode='local';names=NAMES.slice(0,n);setWorld();beginGame()};$('#nums').appendChild(b)}
try{$('#nick').value=localStorage.getItem('ms_nick')||''}catch(e){}
const nm=()=>{const v=($('#nick').value.trim()||'Jogador').slice(0,10);try{localStorage.setItem('ms_nick',v)}catch(e){}return v};
const setSt=t=>$('#st').textContent=t;
const errMsg=e=>e.type==='peer-unavailable'?'Sala não encontrada':/network|server-error|socket/.test(e.type)?'Falha de rede com o servidor de salas. Tente de novo.':'Erro: '+e.type;

/* manter a tela ligada durante a partida online (celular que apaga a tela pausa o jogo) */
async function lockScreen(){try{if('wakeLock' in navigator&&!wake){wake=await navigator.wakeLock.request('screen');wake.addEventListener('release',()=>{wake=null})}}catch(e){}}
function unlockScreen(){try{wake&&wake.release()}catch(e){}wake=null}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){lastMsg=performance.now();if(playing&&mode!=='local')lockScreen()}});

/* ---------- Simulação (roda no anfitrião / local) ---------- */
/* mundo do jogo se adapta ao formato da tela (retrato, quadrado ou paisagem) */
function worldFor(){
  const a=innerWidth/Math.max(1,innerHeight);let w,h;
  if(a>=1){w=640;h=Math.round(Math.min(640,Math.max(360,640/a)))}
  else{h=640;w=Math.round(Math.min(640,Math.max(360,640*a)))}
  return{w,h};
}
function setWorld(){const d=worldFor();W=d.w;H=d.h}
const adiff=(a,b)=>((b-a+Math.PI*3)%(Math.PI*2))-Math.PI;
const mkFish=()=>({x:60+Math.random()*(W-80),y:Math.random()*H,a:Math.random()*6.28,k:Math.random()<.5?0:1});
function newSim(ns){
  const s={t:0,wall:20,over:null,P:[],F:[]};
  ns.forEach((n,i)=>s.P.push({n,x:W-120,y:(i+1)*H/(ns.length+1),vx:0,vy:0,a:Math.PI,alive:true,score:0,cd:0}));
  for(let i=0;i<7;i++)s.F.push(mkFish());
  return s;
}
function step(s,dt,inp){
  s.t+=dt;s.wall=20+(s.t*3+s.t*s.t*.02)*(W/360);
  s.P.forEach((p,i)=>{
    if(!p.alive)return;
    p.cd=Math.max(0,(p.cd||0)-dt);
    const inn=inp[i];
    if(inn&&p.cd<=0){ // nada na direção pedida; m (0..1) controla a força
      const sp=130+190*inn.m;p.vx=Math.cos(inn.a)*sp;p.vy=Math.sin(inn.a)*sp;p.a=inn.a;p.cd=DASH_CD;
    }else{ // sem comando: a pupila acompanha o movimento
      const sp=Math.hypot(p.vx,p.vy);
      if(sp>40){const d=adiff(p.a,Math.atan2(p.vy,p.vx));p.a+=Math.max(-8*dt,Math.min(8*dt,d))}
    }
    const d=Math.pow(.35,dt);p.vx*=d;p.vy=p.vy*d+110*dt;
    p.x+=p.vx*dt;p.y+=p.vy*dt;
    if(p.y<R){p.y=R;p.vy=Math.abs(p.vy)}
    if(p.y>H-R){p.y=H-R;p.vy=-Math.abs(p.vy)*.6}
    if(p.x>W-R){p.x=W-R;p.vx=-Math.abs(p.vx)}
    if(p.x-R<s.wall-6)p.alive=false;
    s.F.forEach((f,k)=>{if(Math.hypot(f.x-p.x,f.y-p.y)<R+10){p.score++;s.F[k]=mkFish();s.F[k].x=Math.max(s.wall+40,s.F[k].x)}});
  });
  s.F.forEach((f,k)=>{
    f.a+=(Math.random()-.5)*2*dt;f.x+=Math.cos(f.a)*34*dt;f.y+=Math.sin(f.a)*34*dt;
    if(f.y<0)f.y=H;if(f.y>H)f.y=0;if(f.x>W-8)f.a=Math.PI-f.a;
    if(f.x<s.wall+8){s.F[k]=mkFish();s.F[k].x=Math.max(s.wall+40,s.F[k].x)}
  });
  const al=s.P.filter(p=>p.alive);
  // vitória por peixes: quem chegar a GOAL primeiro (maior pontuação em caso de empate no mesmo instante)
  let fw=-1,fb=0;
  s.P.forEach((p,i)=>{if(p.alive&&p.score>=GOAL&&p.score>fb){fb=p.score;fw=i}});
  if(fw>=0){s.over={w:fw,r:'fish'};return}
  // fim por eliminação: todos os outros morreram (ou, sozinho, o jogador morreu)
  if(s.P.length==1?!al.length:al.length<=1){
    let w=-1;
    if(al.length)w=s.P.indexOf(al[0]);
    else if(s.P.length>1){let b=-1;s.P.forEach((p,i)=>{if(p.score>b){b=p.score;w=i}})}
    s.over={w,r:'last'};
  }
}

/* ---------- Cliente: suaviza os estados recebidos do anfitrião ---------- */
const lerp=(a,b,u)=>a+(b-a)*u;
function lerpSim(a,b,u){
  const o={t:lerp(a.t,b.t,u),wall:lerp(a.wall,b.wall,u),over:null,P:[],F:[]};
  b.P.forEach((pb,i)=>{const pa=a.P[i]||pb;o.P.push({n:pb.n,alive:pb.alive,score:pb.score,vx:pb.vx,vy:pb.vy,x:lerp(pa.x,pb.x,u),y:lerp(pa.y,pb.y,u),a:pa.a+adiff(pa.a,pb.a)*u})});
  b.F.forEach((fb,i)=>{const fa=a.F[i]||fb;
    if(Math.hypot(fb.x-fa.x,fb.y-fa.y)>60)o.F.push({x:fb.x,y:fb.y,a:fb.a,k:fb.k}); // peixe renasceu: não "desliza"
    else o.F.push({x:lerp(fa.x,fb.x,u),y:lerp(fa.y,fb.y,u),a:lerp(fa.a,fb.a,u),k:fb.k})});
  return o;
}
function onSnap(s){
  if(!playing||!s||!s.P)return;
  if(snaps.length&&s.t<snaps[snaps.length-1].t-.2){snaps=[];rtInit=false} // nova partida
  snaps.push(s);if(snaps.length>40)snaps.shift();
  const target=s.t-DELAY;
  if(!rtInit||Math.abs(target-rt)>.5){rt=target;rtInit=true}else rt+=(target-rt)*.12;
}
function clientView(dt){
  const n=snaps.length;if(!n)return null;
  const newest=snaps[n-1];
  rt=Math.min(rt+dt,newest.t);
  while(snaps.length>2&&snaps[1].t<=rt)snaps.shift();
  let v;
  if(snaps.length<2||rt<=snaps[0].t)v=lerpSim(snaps[0],snaps[0],0);
  else{const a=snaps[0],b=snaps[1];v=lerpSim(a,b,Math.min(1,Math.max(0,(rt-a.t)/((b.t-a.t)||1))))}
  v.over=rt>=newest.t-1e-6?newest.over:null;
  return v;
}

/* ---------- Desenho (visual tecnológico) ---------- */
function rrect(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function glow(x,y,r,c,a){
  const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,c);g.addColorStop(1,'rgba(0,0,0,0)');
  ctx.save();ctx.globalAlpha=a;ctx.globalCompositeOperation='lighter';ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();ctx.restore();
}
function updTrails(s){
  s.P.forEach((p,i)=>{
    const tr=trails[i]||(trails[i]=[]);
    if(!p.alive){tr.length=0;return}
    const l=tr[tr.length-1];
    if(!l||Math.hypot(l.x-p.x,l.y-p.y)>4){tr.push({x:p.x,y:p.y});if(tr.length>14)tr.shift()}
  });
}
function draw(s){
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.setLineDash([]);
  // fundo
  const bg=ctx.createLinearGradient(0,0,0,H);bg.addColorStop(0,'#081329');bg.addColorStop(1,'#03050d');
  ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
  // grade
  ctx.lineWidth=1;ctx.strokeStyle='rgba(0,240,255,.07)';ctx.beginPath();
  for(let x=0;x<=W;x+=36){ctx.moveTo(x,0);ctx.lineTo(x,H)}
  const off=(s.t*14)%36;
  for(let y=-off;y<=H;y+=36){ctx.moveTo(0,y);ctx.lineTo(W,y)}
  ctx.stroke();
  // bits de dados subindo
  for(let i=0;i<16;i++){const y=H-((s.t*22+i*47)%H),x=20+(i*83)%(W-40);ctx.fillStyle='rgba(0,240,255,'+(.06+(i%4)*.03)+')';ctx.fillRect(x,y,2,2+(i%3)*4)}
  // brilho de perigo perto da parede
  const wx=s.wall;
  const dg=ctx.createLinearGradient(wx-6,0,wx+120,0);dg.addColorStop(0,'rgba(255,40,90,.38)');dg.addColorStop(1,'rgba(255,40,90,0)');
  ctx.fillStyle=dg;ctx.fillRect(wx-6,0,126,H);
  // peixes (hologramas)
  s.F.forEach(f=>{
    const c=FISH_C[f.k];
    glow(f.x,f.y,24,c,.28);
    ctx.save();ctx.translate(f.x,f.y);ctx.rotate(f.a);
    ctx.lineWidth=1.8;ctx.strokeStyle=c;ctx.fillStyle=c;
    ctx.beginPath();ctx.moveTo(-9,0);ctx.lineTo(-17,-7);ctx.lineTo(-17,7);ctx.closePath();
    ctx.moveTo(11,0);ctx.ellipse(0,0,11,7,0,0,7);
    ctx.globalAlpha=.25;ctx.fill();ctx.globalAlpha=1;ctx.stroke();
    ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(5,-2,1.8,0,7);ctx.fill();ctx.restore();
  });
  // parede de bocas
  const x=wx;
  const wg=ctx.createLinearGradient(0,0,x,0);wg.addColorStop(0,'#04060e');wg.addColorStop(1,'#1b0f2e');
  ctx.fillStyle=wg;ctx.fillRect(0,0,x-8,H);
  ctx.strokeStyle='rgba(255,46,99,.14)';ctx.lineWidth=1;ctx.beginPath();
  for(let k=1;k<5;k++){const lx=x-8-k*22;ctx.moveTo(lx,0);ctx.lineTo(lx,H)}ctx.stroke();
  ctx.strokeStyle='rgba(255,46,99,.35)';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(x-8,0);ctx.lineTo(x-8,H);ctx.stroke();
  ctx.fillStyle='#14091f';ctx.strokeStyle='#ff2e63';ctx.lineWidth=2;
  for(let y=0;y<=H+13;y+=26){
    const m=.25+.25*Math.sin(s.t*7+y*.3);
    ctx.beginPath();ctx.moveTo(x-6,y);ctx.arc(x-6,y,13,m,Math.PI*2-m);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.fillStyle='#ff2e63';ctx.beginPath();ctx.arc(x-10,y-4,2,0,7);ctx.fill();ctx.fillStyle='#14091f';
  }
  // rastros + jogadores
  s.P.forEach((p,i)=>{
    const tr=trails[i];if(!tr||!p.alive)return;
    ctx.fillStyle=COLORS[i];
    tr.forEach((q,j)=>{ctx.globalAlpha=(j/tr.length)*.3;ctx.beginPath();ctx.arc(q.x,q.y,R*.55*(j/tr.length),0,7);ctx.fill()});
    ctx.globalAlpha=1;
  });
  s.P.forEach((p,i)=>{
    const c=p.alive?COLORS[i]:'#4a5470',ca=Math.cos(p.a),sa=Math.sin(p.a);
    if(p.alive){
      glow(p.x,p.y,R*2.4,c,.4);
      ctx.save();ctx.strokeStyle=c;ctx.globalAlpha=.45;ctx.lineWidth=1.5;ctx.setLineDash([3,5]);
      ctx.beginPath();ctx.moveTo(p.x+ca*R,p.y+sa*R);ctx.lineTo(p.x+ca*(R+44),p.y+sa*(R+44));ctx.stroke();ctx.restore();
    }
    ctx.fillStyle='#091024';ctx.beginPath();ctx.arc(p.x,p.y,R,0,7);ctx.fill();
    if(p.alive){ctx.globalAlpha=.3;ctx.fillStyle=c;ctx.beginPath();ctx.arc(p.x,p.y,R-5,0,7);ctx.fill();ctx.globalAlpha=1}
    ctx.lineWidth=2.5;ctx.strokeStyle=c;ctx.beginPath();ctx.arc(p.x,p.y,R,0,7);ctx.stroke();
    if(p.alive){
      ctx.save();ctx.lineWidth=1.2;ctx.globalAlpha=.7;ctx.setLineDash([4,6]);ctx.lineDashOffset=-s.t*22;
      ctx.beginPath();ctx.arc(p.x,p.y,R-4,0,7);ctx.stroke();ctx.restore();
      ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x+ca*(R-8),p.y+sa*(R-8),5.5,0,7);ctx.fill();
      ctx.fillStyle=c;ctx.beginPath();ctx.arc(p.x+ca*(R-8),p.y+sa*(R-8),2.4,0,7);ctx.fill();
    }else{
      ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(p.x-6,p.y-6);ctx.lineTo(p.x+6,p.y+6);ctx.moveTo(p.x+6,p.y-6);ctx.lineTo(p.x-6,p.y+6);ctx.stroke();
    }
    if(mode!=='local'&&i===me&&p.alive){ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(p.x,p.y-R-5);ctx.lineTo(p.x-6,p.y-R-14);ctx.lineTo(p.x+6,p.y-R-14);ctx.closePath();ctx.fill()}
  });
  // alvo dos dedos / mouse
  holds.forEach(h=>{
    const q=s.P[h.i];if(!q||!q.alive)return;
    ctx.save();ctx.strokeStyle=COLORS[h.i];ctx.lineWidth=2;ctx.globalAlpha=.85;
    ctx.beginPath();ctx.arc(h.x,h.y,9,0,7);ctx.stroke();
    ctx.globalAlpha=.35;ctx.beginPath();ctx.arc(h.x,h.y,17+Math.sin(s.t*9)*3,0,7);ctx.stroke();ctx.restore();
  });
  drawHint(s);
  // HUD
  ctx.font=HUD_FONT;ctx.textAlign='right';
  s.P.forEach((p,i)=>{
    const px=8+i*62,py=8,c=p.alive?COLORS[i]:'#39425c';
    ctx.fillStyle='rgba(4,10,24,.82)';rrect(px,py,58,24,6);ctx.fill();
    ctx.strokeStyle=c;ctx.lineWidth=1.2;ctx.stroke();
    ctx.fillStyle=c;ctx.beginPath();ctx.arc(px+12,py+12,5,0,7);ctx.fill();
    ctx.fillStyle=p.alive?'#fff':'#7d8fb3';ctx.fillText(p.score,px+51,py+17);
  });
}

/* ---------- Dica de controles (some sozinha) ---------- */
function drawHint(s){
  if(s.t>7)return;
  const lines=[];
  if(mode==='local'&&s.P.length>1){
    s.P.forEach((p,i)=>lines.push({c:COLORS[i],t:NAMES[i]+': '+KEYMAPS[i].label}));
    lines.push({c:'#9fb4d8',t:'Toque: arraste perto do seu peixe'});
    lines.push({c:'#ffd60a',t:'Meta: '+GOAL+' peixes ou último vivo'});
  }else{
    lines.push({c:'#d8e6ff',t:'Toque e segure: o peixe nada até o dedo'});
    lines.push({c:'#9fb4d8',t:'PC: mouse, WASD ou setas'});
    lines.push({c:'#ffd60a',t:'Meta: '+GOAL+' peixes'+(s.P.length>1?' ou último vivo':'')});
  }
  const lh=18,pw=Math.min(W-24,250),ph=lines.length*lh+14,x=(W-pw)/2,y=H-ph-14;
  ctx.save();ctx.globalAlpha=Math.min(1,(7-s.t)/1.5);
  ctx.fillStyle='rgba(4,10,24,.78)';rrect(x,y,pw,ph,8);ctx.fill();
  ctx.strokeStyle='rgba(0,240,255,.35)';ctx.lineWidth=1;ctx.stroke();
  ctx.font='700 13px Rajdhani, sans-serif';ctx.textAlign='center';
  lines.forEach((l,k)=>{ctx.fillStyle=l.c;ctx.fillText(l.t,W/2,y+3+lh*(k+1))});
  ctx.restore();
}

/* ---------- Loop e entrada ---------- */
function beginGame(){
  sim=mode==='client'?null:newSim(names);view=mode==='client'?null:sim;
  inA=[];snaps=[];rtInit=false;trails=[];sendAcc=0;playing=true;lastMsg=performance.now();
  holds.clear();down.clear();lastKey='-';lastSend=0;
  $('#over').classList.add('hidden');show('game');fit();netBadge();
  if(mode!=='local')lockScreen();
  if(!running){running=true;last=performance.now();raf=requestAnimationFrame(loop)}
}

/* ----- Controles novos -----
   Toque/mouse: segure em qualquer ponto e o peixe nada até lá (perto do alvo, nada devagar).
   Local com vários jogadores: cada dedo assume o peixe mais próximo que ainda está livre.
   Teclado: direções de cada jogador (ver KEYMAPS); online usa WASD ou setas. */
const gameEl=$('#game');
function worldPt(e){
  const r=cv.getBoundingClientRect();
  return{x:(e.clientX-r.left)/Math.max(1,r.width)*W,y:(e.clientY-r.top)/Math.max(1,r.height)*H};
}
gameEl.addEventListener('pointerdown',e=>{
  if(!playing||!view||view.over)return;
  if(e.pointerType==='mouse'&&e.button!==0)return;
  if(e.target.closest&&e.target.closest('#btnExit,#over'))return;
  e.preventDefault();
  const pt=worldPt(e);let i=me;
  if(mode==='local'){
    const taken=new Set([...holds.values()].map(h=>h.i));
    let best=-1,bd=1e9;
    view.P.forEach((p,k)=>{
      if(!p.alive||taken.has(k))return;
      const d=Math.hypot(p.x-pt.x,p.y-pt.y);if(d<bd){bd=d;best=k}
    });
    if(best<0)return;i=best;
  }
  holds.set(e.pointerId,{i,x:pt.x,y:pt.y});
  try{gameEl.setPointerCapture(e.pointerId)}catch(_){}
});
gameEl.addEventListener('pointermove',e=>{
  const h=holds.get(e.pointerId);if(!h)return;
  const pt=worldPt(e);h.x=pt.x;h.y=pt.y;
});
['pointerup','pointercancel','lostpointercapture'].forEach(n=>gameEl.addEventListener(n,e=>holds.delete(e.pointerId)));
gameEl.addEventListener('contextmenu',e=>e.preventDefault());

addEventListener('keydown',e=>{
  if(!playing||!GAME_CODES.has(e.code))return;
  e.preventDefault();down.add(e.code);
});
addEventListener('keyup',e=>{down.delete(e.code)});
addEventListener('blur',()=>{down.clear();holds.clear()});

const kmaps=i=>mode==='local'&&names.length>1?[KEYMAPS[i]]:[KEYMAPS[0],KEYMAPS[1]];
function keyVec(i){
  let x=0,y=0;
  kmaps(i).forEach(m=>{
    if(down.has(m.l))x--;if(down.has(m.r))x++;
    if(down.has(m.u))y--;if(down.has(m.d)||(m.d2&&down.has(m.d2)))y++;
  });
  return x||y?{a:Math.atan2(y,x),m:1}:null;
}
/* devolve, por jogador controlado neste aparelho, {a:ângulo,m:força} ou null */
function gather(){
  const out=[],v=view;if(!v)return out;
  const idxs=mode==='local'?v.P.map((_,i)=>i):[me];
  idxs.forEach(i=>{
    const p=v.P[i];
    if(!p||!p.alive){out[i]=null;return}
    let aim=null;
    holds.forEach(h=>{
      if(h.i!==i)return;
      const dx=h.x-p.x,dy=h.y-p.y,d=Math.hypot(dx,dy);
      aim={a:d<5?p.a:Math.atan2(dy,dx),m:Math.min(1,Math.max(.2,d/70))};
    });
    out[i]=aim||keyVec(i);
  });
  return out;
}
/* cliente: envia o comando ao anfitrião só quando muda (e no máx. ~30x/s) */
function sendInput(aim){
  const k=aim?Math.round(aim.a*20)+':'+Math.round(aim.m*5):'-';
  const now=performance.now();
  if(k===lastKey||(aim&&now-lastSend<33))return;
  if(hostConn&&hostConn.open){hostConn.send({t:'in',a:aim?aim.a:null,m:aim?aim.m:0});lastKey=k;lastSend=now}
}
function loop(t){
  if(!running)return;
  const dt=Math.min((t-last)/1000,.05);last=t;
  if(mode==='client'){
    view=clientView(dt);
    if(playing&&performance.now()-lastMsg>7000){alert('Conexão com o anfitrião perdida.');toMenu();return}
    sendInput(view&&!view.over?(gather()[me]||null):null);
  }else if(sim){
    if(!sim.over){
      const ag=gather();
      (mode==='local'?sim.P.map((_,i)=>i):[0]).forEach(i=>{inA[i]=ag[i]||null});
      step(sim,dt,inA);
      if(mode==='host'){sendAcc+=dt;if(sendAcc>=SEND_DT||sim.over){sendAcc=0;broadcast({t:'s',s:sim})}}
    }
    view=sim;
  }
  if(view){
    updTrails(view);draw(view);
    if(view.over&&$('#over').classList.contains('hidden'))showOver(view);
  }
  raf=requestAnimationFrame(loop);
}
function showOver(v){
  const w=v.over.w;
  const fish=v.over.r==='fish';
  $('#overTxt').textContent=v.P.length==1?(fish?`🏆 Você pegou ${GOAL} peixes!`:`Você fez ${v.P[0].score} pontos!`):w>=0?(fish?`🏆 ${v.P[w].n} pegou ${GOAL} peixes e venceu!`:`🏆 ${v.P[w].n} venceu! (${v.P[w].score} pts)`):'Empate!';
  $('#btnAgain').classList.toggle('hidden',mode==='client');
  $('#overWait').classList.toggle('hidden',mode!=='client');
  $('#over').classList.remove('hidden');
}
$('#btnAgain').onclick=()=>{
  if(mode==='host'){reindex();setWorld();beginGame();broadcast({t:'start',names,w:W,h:H})}
  else{setWorld();beginGame()}
};
function netBadge(){
  const n=$('#net');
  if(mode!=='host'&&mode!=='client'){n.classList.add('hidden');return}
  n.classList.remove('hidden');
  if(mode==='host'){n.className='off';n.textContent=`SALA ${$('#roomCode').textContent} · ${conns.length+1} ONLINE`}
  else if(rtt==null){n.className='off';n.textContent='CONECTANDO…'}
  else{n.className=rtt<90?'':rtt<180?'mid':'bad';n.textContent=`PING ${Math.round(rtt)} ms`}
}

/* ---------- Online (PeerJS/WebRTC: PC, celular e tablet entram na mesma sala) ---------- */
const broadcast=m=>conns.forEach(c=>c.open&&c.send(m));
const code4=()=>Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('');
function lobbyUI(){
  const ul=$('#players');ul.innerHTML='';
  names.forEach((n,i)=>{const li=document.createElement('li');li.style.setProperty('--pc',COLORS[i]);li.textContent=n+(i===0?' 👑':'')+(i===me?' (você)':'');ul.appendChild(li)});
  $('#count').textContent=names.length+' / '+MAXP;
}
function sendLobby(){lobbyUI();broadcast({t:'lobby',names})}
function reindex(){
  const nn=[names[0]];
  conns.forEach((c,k)=>{nn.push(names[c.idx]);c.idx=k+1;c.send({t:'you',i:c.idx})});
  names=nn;
}
$('#btnCreate').onclick=()=>{
  if(typeof Peer==='undefined')return setSt('Não foi possível carregar o módulo online. Verifique a internet.');
  const nick=nm();cleanup();mode='host';me=0;names=[nick];
  const code=code4();setSt('Criando sala...');
  peer=new Peer('mordida-'+code,PEER_OPTS);
  peer.on('open',()=>{$('#roomCode').textContent=code;$('#btnStart').classList.remove('hidden');$('#wait').classList.add('hidden');$('#shareMsg').textContent='';lobbyUI();show('lobby')});
  peer.on('error',e=>{if(e.type==='unavailable-id')$('#btnCreate').click();else setSt(errMsg(e))});
  peer.on('disconnected',()=>{try{peer&&!peer.destroyed&&peer.reconnect()}catch(e){}}); // celular que perdeu o sinal do servidor volta sozinho
  peer.on('connection',c=>{
    c.on('open',()=>{
      if((sim&&!sim.over)||names.length>=MAXP){c.send({t:'full'});setTimeout(()=>c.close(),300);return}
      c.idx=names.length;names.push('Jogador');conns.push(c);c.send({t:'you',i:c.idx});
    });
    c.on('data',m=>{
      if(!m)return;
      if(m.t==='join'){names[c.idx]=String(m.n).slice(0,10);sendLobby()}
      else if(m.t==='in'){
        inA[c.idx]=(typeof m.a==='number'&&isFinite(m.a))?{a:m.a,m:Math.min(1,Math.max(.2,+m.m||.2))}:null;
      }
      else if(m.t==='ping')c.send({t:'pong',ts:m.ts});
    });
    c.on('close',()=>{
      if(!conns.includes(c))return;
      conns=conns.filter(x=>x!==c);
      if(sim&&!sim.over){if(sim.P[c.idx])sim.P[c.idx].alive=false}
      else{reindex();sendLobby()}
      netBadge();
    });
  });
};
$('#btnJoin').onclick=()=>{
  const code=$('#code').value.trim().toUpperCase();
  if(code.length!=4)return setSt('Digite o código de 4 letras');
  if(typeof Peer==='undefined')return setSt('Não foi possível carregar o módulo online. Verifique a internet.');
  const nick=nm();cleanup();mode='client';setSt('Conectando...');
  let joined=false;
  joinTimer=setTimeout(()=>{if(mode==='client'&&!joined){cleanup();setSt('Não foi possível conectar. Confira o código e a internet dos dois aparelhos.')}},15000);
  peer=new Peer(undefined,PEER_OPTS);
  peer.on('open',()=>{
    hostConn=peer.connect('mordida-'+code,{reliable:true});
    hostConn.on('open',()=>{
      joined=true;clearTimeout(joinTimer);lastMsg=performance.now();
      hostConn.send({t:'join',n:nick});
      $('#roomCode').textContent=code;$('#btnStart').classList.add('hidden');$('#wait').classList.remove('hidden');$('#shareMsg').textContent='';
      const ping=()=>{if(hostConn&&hostConn.open)hostConn.send({t:'ping',ts:performance.now()})};
      ping();pingTimer=setInterval(ping,2000);
    });
    hostConn.on('data',onClientMsg);
    hostConn.on('close',()=>{if(mode==='client'){alert('A sala foi encerrada.');toMenu()}});
  });
  peer.on('error',e=>{if(mode==='client'&&!joined){cleanup();setSt(errMsg(e))}});
};
$('#code').addEventListener('keydown',e=>{if(e.key==='Enter')$('#btnJoin').click()});
function onClientMsg(m){
  if(!m)return;
  lastMsg=performance.now();
  switch(m.t){
    case 'lobby':names=m.names;lobbyUI();if($('#game').classList.contains('hidden'))show('lobby');break;
    case 'you':me=m.i;break;
    case 'start':names=m.names;W=m.w||360;H=m.h||640;beginGame();break;
    case 's':onSnap(m.s);break;
    case 'pong':{const d=performance.now()-m.ts;rtt=rtt==null?d:rtt*.7+d*.3;netBadge();break}
    case 'full':alert('Sala cheia ou jogo em andamento.');toMenu();break;
  }
}
$('#btnStart').onclick=()=>{if(mode!=='host')return;setWorld();beginGame();broadcast({t:'start',names,w:W,h:H})};

/* link da sala: o amigo abre no celular/PC e já cai com o código preenchido */
$('#btnShare').onclick=async()=>{
  const url=location.href.split('#')[0].split('?')[0]+'?sala='+$('#roomCode').textContent;
  const msg=t=>{$('#shareMsg').textContent=t;setTimeout(()=>{$('#shareMsg').textContent=''},2500)};
  try{if(navigator.share){await navigator.share({title:'Mordida Selvagem',text:'Entre na minha sala!',url});return}}catch(e){if(e&&e.name==='AbortError')return}
  try{await navigator.clipboard.writeText(url);msg('Link copiado!')}catch(e){prompt('Copie o link da sala:',url)}
};
(function(){
  const pre=(new URLSearchParams(location.search).get('sala')||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,4);
  if(pre.length===4){$('#code').value=pre;show('online');setSt('Código da sala preenchido. Digite seu nome e entre!')}
})();
