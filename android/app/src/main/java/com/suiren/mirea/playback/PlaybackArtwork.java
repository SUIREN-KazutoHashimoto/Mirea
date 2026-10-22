package com.suiren.mirea.playback;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

/** Bounded, in-memory cover data; no credentials or public artwork URI. */
final class PlaybackArtwork {
    static Bitmap decode(byte[] bytes){
        if(bytes==null||bytes.length>3*1024*1024)return null;
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        if(options.outWidth<1||options.outHeight<1||options.outWidth>8192||options.outHeight>8192||(long)options.outWidth*options.outHeight>16777216L)return null;
        options.inJustDecodeBounds=false;options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>512)options.inSampleSize*=2;
        return BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
    }
}
