package com.suiren.mirea.playback;

import android.content.Context;
import android.net.Uri;
import android.view.Surface;
import androidx.media3.common.*;
import androidx.media3.datasource.*;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import java.io.*;
import java.net.*;
import org.json.*;

/** HLS stays on the authenticated origin. No disk cache or credentials in URLs. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
final class AdaptivePlayback {
    interface Events {void ready();void buffering(boolean value);void ended();void failed();void changed();void seeked();}
    final ExoPlayer player;
    private final JSONArray qualities;
    private final DefaultTrackSelector selector;
    AdaptivePlayback(Context context,PlaybackApi api,String id,String generation,JSONArray qualities,Events events){
        this.qualities=qualities;
        selector=new DefaultTrackSelector(context);player=new ExoPlayer.Builder(context).setTrackSelector(selector).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),false);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.addListener(new Player.Listener(){
            boolean announced;
            public void onPlaybackStateChanged(int state){events.buffering(state==Player.STATE_BUFFERING);if(state==Player.STATE_READY&&!announced){announced=true;events.ready();}if(state==Player.STATE_ENDED)events.ended();events.changed();}
            public void onPlayerError(PlaybackException error){events.failed();}
            public void onVideoSizeChanged(VideoSize size){events.changed();}
            public void onTracksChanged(Tracks tracks){events.changed();}
            public void onPositionDiscontinuity(Player.PositionInfo a,Player.PositionInfo b,int reason){if(reason==Player.DISCONTINUITY_REASON_SEEK)events.seeked();}
        });
        String url=api.origin+"/api/v1/items/"+id+"/hls/master.m3u8?generation="+generation;
        DataSource.Factory factory=()->new OriginSource(api,id,generation);
        player.setMediaSource(new HlsMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(url)));
    }
    void quality(String mode){
        DefaultTrackSelector.Parameters.Builder b=selector.buildUponParameters().clearVideoSizeConstraints().setMinVideoSize(0,0).setForceHighestSupportedBitrate(false).setForceLowestBitrate(false).setExceedVideoConstraintsIfNecessary(false);
        if("higher".equals(mode))b.setForceHighestSupportedBitrate(true);
        else if("data".equals(mode)){JSONObject limit=null;for(int n=0;n<qualities.length();n++){JSONObject r=qualities.optJSONObject(n);if(r==null)continue;int h=Math.min(r.optInt("width"),r.optInt("height")),old=limit==null?Integer.MAX_VALUE:Math.min(limit.optInt("width"),limit.optInt("height"));if(limit==null||old>480&&h<old||h<=480&&old<=480&&h>old)limit=r;}if(limit!=null)b.setMaxVideoSize(limit.optInt("width"),limit.optInt("height"));}
        else for(int n=0;n<qualities.length();n++){JSONObject r=qualities.optJSONObject(n);if(r!=null&&mode.equals(r.optString("quality"))){int w=r.optInt("width"),h=r.optInt("height");b.setMinVideoSize(w,h).setMaxVideoSize(w,h);break;}}
        selector.setParameters(b.build());
    }
    String actual(){Format f=player.getVideoFormat();if(f!=null)for(int n=0;n<qualities.length();n++){JSONObject r=qualities.optJSONObject(n);if(r!=null&&r.optInt("width")==f.width&&r.optInt("height")==f.height)return r.optString("quality");}return "unknown";}
    static String authorizedPath(PlaybackApi api,String id,String generation,Uri uri)throws IOException{
        String prefix=api.origin+"/api/v1/items/"+id+"/hls/";
        String value=uri.toString();if(!value.startsWith(prefix)||!value.substring(prefix.length()).matches("(?:master\\.m3u8|[0-9]{2,4}p(?:\\.m3u8|-init\\.mp4|-[0-9]{5}\\.m4s))\\?generation="+java.util.regex.Pattern.quote(generation)))throw new IOException("HLS resource outside asset generation");
        return value.substring(api.origin.length());
    }
    static final class OriginSource extends BaseDataSource {
        private final PlaybackApi api;private final String id,generation;private HttpURLConnection connection;private InputStream input;private Uri uri;private long remaining;private boolean started;
        OriginSource(PlaybackApi api,String id,String generation){super(true);this.api=api;this.id=id;this.generation=generation;}
        public long open(DataSpec spec)throws IOException{
            transferInitializing(spec);uri=spec.uri;String path=authorizedPath(api,id,generation,uri);if(spec.position<0||spec.httpMethod!=DataSpec.HTTP_METHOD_GET)throw new IOException("Unsupported HLS request");
            try{connection=api.connection(path,"GET");boolean ranged=spec.position>0||spec.length!=C.LENGTH_UNSET;if(ranged)connection.setRequestProperty("Range","bytes="+spec.position+"-"+(spec.length==C.LENGTH_UNSET?"":spec.position+spec.length-1));int status=connection.getResponseCode();if(status!=(ranged?206:200))throw new PlaybackApi.Failure(status);remaining=connection.getContentLengthLong();long max=path.contains(".m3u8")?1048576:33554432;if(remaining<0||remaining>max)throw new IOException("Invalid HLS length");if(ranged){String range=connection.getHeaderField("Content-Range");if(range==null||!range.matches("bytes "+spec.position+"-"+(spec.position+remaining-1)+"/[0-9]+")||spec.length!=C.LENGTH_UNSET&&remaining!=spec.length)throw new IOException("Invalid HLS range");}input=connection.getInputStream();started=true;transferStarted(spec);return remaining;}catch(IOException e){close();throw e;}
        }
        public int read(byte[] bytes,int offset,int length)throws IOException{if(api.closed)throw new IOException("Playback context closed");if(length==0)return 0;if(remaining==0)return C.RESULT_END_OF_INPUT;int n=input.read(bytes,offset,(int)Math.min(length,remaining));if(n<0)throw new EOFException("Truncated HLS response");remaining-=n;bytesTransferred(n);return n;}
        public Uri getUri(){return uri;}
        public void close()throws IOException{try{if(input!=null)input.close();}finally{input=null;if(connection!=null)connection.disconnect();connection=null;uri=null;if(started){started=false;transferEnded();}}}
    }
}
