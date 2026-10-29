package com.suiren.mirea.playback;

import android.content.Context;
import android.net.Uri;
import android.view.Surface;
import androidx.media3.common.*;
import androidx.media3.datasource.*;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import java.io.*;
import java.net.*;
import org.json.*;

/** Bounded ahead buffering for authenticated HLS and progressive media. No disk cache. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
final class AdaptivePlayback {
    interface Events {void ready();void buffering(boolean value);void ended();void failed();void changed();void seeked();default void audioSession(int id){}}
    final ExoPlayer player;
    private final JSONArray qualities;
    private final DefaultTrackSelector selector;
    private Events events;private boolean announced;
    AdaptivePlayback(Context context,PlaybackApi api,String id,String generation,String contentPath,long contentSize,JSONArray qualities,Events events){
        this(context,api,id,generation,contentPath,contentSize,qualities,events,false);
    }
    AdaptivePlayback(Context context,PlaybackApi api,String id,String generation,String contentPath,long contentSize,JSONArray qualities,Events callbacks,boolean preload){
        this.events=callbacks;
        this.qualities=qualities;
        selector=new DefaultTrackSelector(context);
        DefaultLoadControl buffers=new DefaultLoadControl.Builder().setBufferDurationsMs(60000,180000,750,1500)
            .setTargetBufferBytes(bufferBytes(Runtime.getRuntime().maxMemory())).setPrioritizeTimeOverSizeThresholds(false).setBackBuffer(preload?0:10000,true).build();
        player=new ExoPlayer.Builder(context).setTrackSelector(selector).setLoadControl(buffers).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),false);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.addListener(new Player.Listener(){
            public void onPlaybackStateChanged(int state){events.buffering(state==Player.STATE_BUFFERING);if(state==Player.STATE_READY&&!announced){announced=true;events.ready();}if(state==Player.STATE_ENDED)events.ended();events.changed();}
            public void onPlayerError(PlaybackException error){events.failed();}
            public void onVideoSizeChanged(VideoSize size){events.changed();}
            public void onTracksChanged(Tracks tracks){events.changed();}
            public void onAudioSessionIdChanged(int id){events.audioSession(id);}
            public void onPositionDiscontinuity(Player.PositionInfo a,Player.PositionInfo b,int reason){if(reason==Player.DISCONTINUITY_REASON_SEEK)events.seeked();}
        });
        if(generation!=null){
            String url=api.origin+"/api/v1/items/"+id+"/hls/master.m3u8?generation="+generation;
            DataSource.Factory factory=()->new OriginSource(api,id,generation);
            player.setMediaSource(new HlsMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(url)));
        }else{
            DataSource.Factory factory=()->new ProgressiveSource(api,id,contentPath,contentSize);
            player.setMediaSource(new ProgressiveMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(api.origin+contentPath)));
        }
    }
    void adoptEvents(Events callbacks){events=callbacks;announced=false;events.audioSession(player.getAudioSessionId());if(player.getPlaybackState()==Player.STATE_READY){announced=true;events.ready();}events.changed();}
    static int bufferBytes(long heap){return (int)Math.max(8L*1024*1024,Math.min(64L*1024*1024,heap/8));}
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
    /** Exact origin/path and length stay pinned while an original is promoted. */
    static final class ProgressiveSource extends BaseDataSource {
        interface ConnectionFactory {HttpURLConnection open(String path)throws IOException;}
        private final PlaybackApi api;private final String path;private final long size;private final ConnectionFactory connections;private HttpURLConnection connection;private InputStream input;private Uri uri;private long remaining;private boolean started;
        ProgressiveSource(PlaybackApi api,String id,String path,long size){this(api,id,path,size,p->api.connection(p,"GET"));}
        ProgressiveSource(PlaybackApi api,String id,String path,long size,ConnectionFactory connections){super(true);this.api=api;this.path=path;this.size=size;this.connections=connections;
            if(!PlaybackApi.uuid(id)||size<1||size>8589934592L||path==null||!path.matches("/api/v1/items/"+java.util.regex.Pattern.quote(id)+"/content(?:\\?ticket=[A-Za-z0-9_-]{43})?"))throw new IllegalArgumentException("Invalid progressive resource");}
        static void validateRange(long position,long requested,long size,int status,long length,String range)throws IOException{
            if(position<0||position>=size||requested==0||requested<C.LENGTH_UNSET)throw new IOException("Invalid media range");
            boolean ranged=position>0||requested!=C.LENGTH_UNSET;long expected=requested==C.LENGTH_UNSET?size-position:Math.min(requested,size-position);
            if(status!=(ranged?206:200))throw new PlaybackApi.Failure(status);
            if(length!=expected||ranged&&!("bytes "+position+"-"+(position+expected-1)+"/"+size).equals(range))throw new IOException("Invalid media length/range");
        }
        public long open(DataSpec spec)throws IOException{
            transferInitializing(spec);uri=spec.uri;if(!uri.toString().equals(api.origin+path)||spec.httpMethod!=DataSpec.HTTP_METHOD_GET||spec.position<0||spec.position>=size)throw new IOException("Media resource outside asset");
            try{connection=connections.open(path);boolean ranged=spec.position>0||spec.length!=C.LENGTH_UNSET;
                if(ranged){long end=spec.length==C.LENGTH_UNSET?size-1:spec.position+Math.min(spec.length,size-spec.position)-1;connection.setRequestProperty("Range","bytes="+spec.position+"-"+end);}
                int status=connection.getResponseCode();remaining=connection.getContentLengthLong();validateRange(spec.position,spec.length,size,status,remaining,connection.getHeaderField("Content-Range"));
                input=connection.getInputStream();started=true;transferStarted(spec);return remaining;
            }catch(IOException e){close();throw e;}
        }
        public int read(byte[] bytes,int offset,int length)throws IOException{if(api.closed)throw new IOException("Playback context closed");if(length==0)return 0;if(remaining==0)return C.RESULT_END_OF_INPUT;int n=input.read(bytes,offset,(int)Math.min(length,remaining));if(n<0)throw new EOFException("Truncated media response");remaining-=n;bytesTransferred(n);return n;}
        public Uri getUri(){return uri;}
        public void close()throws IOException{try{if(input!=null)input.close();}finally{input=null;if(connection!=null)connection.disconnect();connection=null;uri=null;if(started){started=false;transferEnded();}}}
    }
}
