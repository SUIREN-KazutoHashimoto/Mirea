package com.suiren.mirea.playback;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Context;
import org.json.JSONObject;

/** Bounded, in-memory cover data; no credentials or public artwork URI. */
final class PlaybackArtwork {
    interface SavedGrant {JSONObject load(PlaybackApi api,String id)throws Exception;}
    static Bitmap forRequest(Context context,PlaybackApi api,JSONObject request){
        return forRequest(api,request,(target,id)->new com.suiren.mirea.transfer.TransferLease(context).load(target,id));
    }
    static Bitmap forRequest(PlaybackApi api,JSONObject request,SavedGrant saved){
        Bitmap embedded=embedded(request.optString("artwork"));if(embedded!=null)return embedded;
        // The transfer grant already stores its encrypted, account-bound cover.
        // An expired/missing grant must never substitute another asset's image.
        JSONObject manifest=request.optJSONObject("download"),item=request.optJSONObject("item");if(manifest==null||item==null)return null;
        try{String id=manifest.getString("id"),asset=item.getString("id");if(!PlaybackApi.uuid(id)||!asset.equals(manifest.optString("assetId")))return null;
            JSONObject grant=saved.load(api,id),verified=grant.getJSONObject("manifest"),cover=grant.optJSONObject("cover");
            if(!api.userId.equals(grant.optString("userId"))||!id.equals(verified.optString("id"))||!asset.equals(verified.optString("assetId"))||cover==null)return null;
            return embedded(cover.optString("bytes"));
        }catch(Exception unavailable){return null;}
    }
    static Bitmap embedded(String encoded){
        if(encoded==null||encoded.isEmpty()||encoded.length()>((2*1024*1024+2)/3)*4)return null;
        byte[] bytes=null;try{bytes=java.util.Base64.getDecoder().decode(encoded);return bytes.length<=2*1024*1024?decode(bytes):null;}catch(IllegalArgumentException malformed){return null;}finally{if(bytes!=null)java.util.Arrays.fill(bytes,(byte)0);}
    }
    static Bitmap decode(byte[] bytes){
        if(bytes==null||bytes.length>3*1024*1024)return null;
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        if(options.outWidth<1||options.outHeight<1||options.outWidth>8192||options.outHeight>8192||(long)options.outWidth*options.outHeight>16777216L)return null;
        options.inJustDecodeBounds=false;options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>512)options.inSampleSize*=2;
        return BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
    }
}
