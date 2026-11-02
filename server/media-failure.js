import {httpError} from './security.js';
import {normalizeImageDiagnostic} from './error-diagnostic-schema.js';

const filesystem=new Set(['ENOENT','EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','ENODEV','ESTALE','EMFILE','ENFILE']);
// Decoder text may contain private paths. Classify it, but never send that text
// to the client. The raw cause remains available only in ordinary server logs.
export function decoderFailureCode(message,nativeCode){
 if(filesystem.has(nativeCode))return nativeCode;
 if(['IMAGE_FORMAT_UNSUPPORTED','IMAGE_ANIMATED_UNSUPPORTED'].includes(nativeCode))return nativeCode;
 const text=typeof message==='string'?message.slice(0,16384):'';
 if(/no space left on device|not enough space on (?:the )?disk|disk (?:is )?full/i.test(text))return 'ENOSPC';
 if(/disk quota exceeded/i.test(text))return 'EDQUOT';
 if(/read-only file system/i.test(text))return 'EROFS';
 if(/input file is missing|no such file or directory/i.test(text))return 'ENOENT';
 if(/permission denied|access is denied/i.test(text))return 'EACCES';
 if(/premature end|unexpected end|truncat|end of (?:file|buffer)|end-of-buffer/i.test(text))return 'IMAGE_TRUNCATED';
 if(/icc|colour profile|color profile|profile.*(?:invalid|corrupt)|lcms/i.test(text))return 'IMAGE_PROFILE_INVALID';
 if(/corrupt jpeg|invalid jpeg|bogus|invalid marker|not a jpeg|bad huffman|invalid.*data|crc error/i.test(text))return 'IMAGE_INVALID_DATA';
 return 'IMAGE_DECODE_FAILED';
}
const messages={
 ENOENT:'処理対象のファイルが見つかりません。保存領域の接続状態を確認してください。',
 EACCES:'処理対象のファイルを読み込めません。保存先のアクセス権を確認してください。',
 EPERM:'処理対象のファイルを読み込めません。保存先のアクセス権を確認してください。',
 EROFS:'保存先が読み取り専用のため処理できません。',
 ENOSPC:'保存領域に空きがないため処理できません。',EDQUOT:'保存領域の容量制限に達したため処理できません。',
 IMAGE_FORMAT_UNSUPPORTED:'JPEG・PNG・WebPの静止画像を選択してください。',
 IMAGE_ANIMATED_UNSUPPORTED:'複数フレームの画像は画像書籍に使用できません。静止画像を選択してください。',
 IMAGE_TRUNCATED:'画像データの途中または末尾が欠けているため読み込めません。',
 IMAGE_PROFILE_INVALID:'画像の色設定（ICCプロファイル）を読み込めません。',
 IMAGE_INVALID_DATA:'画像のデータ構造を読み込めません。',
 IMAGE_DECODE_FAILED:'画像を読み込めません。エラーの詳細で対象ページと処理段階を確認してください。'
};
export function mediaFailure(result,mode){
 const imageMode=mode==='validate-image'||mode==='image-thumbnail';
 let code=decoderFailureCode(result.error,result.code);
 if(!imageMode&&!filesystem.has(code))code=mode==='epub-thumbnail'?'EPUB_DECODE_FAILED':'PDF_DECODE_FAILED';
 const message=messages[code]??(code==='EPUB_DECODE_FAILED'?'EPUBを読み込めません。破損・DRM・固定レイアウト・サイズ制限を確認してください。':code==='PDF_DECODE_FAILED'?'PDFを読み込めません。破損・暗号化・対応形式を確認してください。':'保存領域からファイルを読み込めません。');
 const cause=Object.assign(new Error(typeof result.error==='string'?result.error:'Media decoder failed'),{code});
 if(typeof result.stack==='string')cause.stack=result.stack;
 return Object.assign(httpError(filesystem.has(code)?503:422,message),{code,cause,...(imageMode?{image:normalizeImageDiagnostic(result.image??{stage:mode==='validate-image'?'page-validation':'thumbnail'})}:{})});
}
export function imageBookFailure(error,{page,pages,stage,format,phase}){
 error.image=normalizeImageDiagnostic({format,...error.image,page,pages,stage,...(phase?{phase}:{})});
 // All text here is fixed application text; filenames stay in the owner's
 // upload details and are excluded from the copyable diagnostic projection.
 if(error.statusCode>=400&&error.statusCode<600)error.message=`画像書籍の${page} / ${pages}ページ目（${stage==='thumbnail'?'表紙生成':'ページ検証'}）：${error.message}`;
 return error;
}
