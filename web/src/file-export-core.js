export async function createExportWriter(exporter,name,mime,size){
  const {handle}=await exporter.begin({name,mime,size});let closed=false;
  return {async write(bytes){
    if(closed)throw new Error('保存先は閉じられています。');
    const input=new Uint8Array(bytes);
    for(let offset=0;offset<input.length;offset+=256*1024){
      const chunk=input.subarray(offset,offset+256*1024);let binary='';
      for(let start=0;start<chunk.length;start+=8192)binary+=String.fromCharCode(...chunk.subarray(start,start+8192));
      await exporter.append({handle,data:btoa(binary)});
    }
  },async close(){if(closed)return;try{await exporter.finish({handle});}finally{closed=true;}},async abort(){if(!closed){closed=true;await exporter.abort({handle});}}};
}
