export function compareVersions(client,server){
 const parse=value=>{const match=/^(\d+)\.(\d+)\.(\d+)(-?beta)?$/.exec(value??'');if(!match)return null;const parts=match.slice(1,4).map(Number);return parts.every(Number.isSafeInteger)?[...parts,match[4]?0:1]:null;},a=parse(client),b=parse(server);
 if(!a||!b)return {known:false,majorMismatch:false,update:false};
 // A final release follows a beta with the same numeric version. Keep the
 // major compatibility boundary independent of this release-stage ordering.
 let order=0;for(let n=0;n<4;n++)if(a[n]!==b[n]){order=a[n]<b[n]?-1:1;break;}
 return {known:true,majorMismatch:a[0]!==b[0],update:order<0};
}
