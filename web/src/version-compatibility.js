export function compareVersions(client,server){
 const parse=value=>/^(\d+)\.(\d+)\.(\d+)(?:-?beta)?$/.exec(value??'')?.slice(1).map(Number),a=parse(client),b=parse(server);
 if(!a||!b)return {known:false,majorMismatch:false,update:false};
 let order=0;for(let n=0;n<3;n++)if(a[n]!==b[n]){order=a[n]<b[n]?-1:1;break;}
 return {known:true,majorMismatch:a[0]!==b[0],update:order<0};
}
