// Constrain generation as well as validating it before publication.
const text=maxLength=>({type:'string',maxLength});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const AI_OCR_OUTPUT=object({blocks:{type:'array',maxItems:128,items:object({text:text(2000),bbox:{type:'array',items:{type:'integer',minimum:0,maximum:1000},minItems:4,maxItems:4},kind:{type:'string',enum:['text','dialogue','narration','sound-effect']}})}});
export const AI_TAG_OUTPUT=object({tags:{type:'array',maxItems:12,items:object({label:text(80),category:{type:'string',enum:['genre','topic','mood','language']}})},summary:text(2000)});
export function aiChapterOutput(start,end){return object({segments:{type:'array',maxItems:12,items:object({startMs:{type:'integer',minimum:start,maximum:end-1},endMs:{type:'integer',minimum:start+1,maximum:end},label:text(160),text:text(2000)})}});}
export function ocrBox(value,tile=[0,0,1,1]){
 if(!Array.isArray(value)||value.length!==4||value.some(n=>!Number.isInteger(n)||n<0||n>1000)||value[2]<=value[0]||value[3]<=value[1])throw Object.assign(Error('Invalid model coordinates'),{code:'AI_OUTPUT_INVALID'});
 return [tile[0]+value[0]/1000*tile[2],tile[1]+value[1]/1000*tile[3],(value[2]-value[0])/1000*tile[2],(value[3]-value[1])/1000*tile[3]];
}
