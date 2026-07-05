// Arbol de ficheros respaldado por el ADF (OFS, Workbench 1.3). Nodos perezosos.
const adf = require("/tmp/adf.js");
const rl=(b,o)=>(b[o]<<24|b[o+1]<<16|b[o+2]<<8|b[o+3])>>>0;

function nodeFromBlock(blockNum, name){
  const b = adf.blk(blockNum);
  const secType = rl(b,508)|0;          // 2=dir/root, -3=file
  const isDir = (secType===2 || secType===1);
  const size = isDir?0:(rl(b,324)>>>0); // fib: file size
  const prot = isDir?0:(rl(b,320)>>>0);
  // fecha del header (days/mins/ticks en offset 420 para file header)
  const days=rl(b,420), mins=rl(b,424), ticks=rl(b,428);
  return {
    name: name!=null?name:adf.nameOf(b),
    block: blockNum, isDir, size, prot, days, mins, ticks,
    children(){ return adf.listDir(blockNum).filter(e=>e.secType===2||e.secType===-3).map(e=>nodeFromBlock(e.block, e.name)); },
    data(){ return Uint8Array.from(adf.readFileOFS(blockNum)); },
  };
}

function makeVfs(){
  const root = nodeFromBlock(adf.ROOT, "Workbench1.3");
  // resuelve una ruta (relativa a 'cwd' o absoluta con "vol:") a un nodo, o null
  function resolve(path, cwd){
    if(!path) return cwd||root;
    let p=path, base=cwd||root;
    let colon=p.indexOf(":");
    if(colon>=0){ base=root; p=p.slice(colon+1); }      // "vol:rest" -> desde raiz
    if(!p) return base;
    let node=base;
    for(const part of p.split("/")){
      if(part===""){ node=root; continue; }            // "/" sube/raiz (simplificado)
      if(!node || !node.isDir) return null;
      let kids=node.children(); let m=kids.find(k=>k.name.toLowerCase()===part.toLowerCase());
      if(!m) return null; node=m;
    }
    return node;
  }
  return { root, resolve };
}
module.exports={makeVfs, nodeFromBlock};