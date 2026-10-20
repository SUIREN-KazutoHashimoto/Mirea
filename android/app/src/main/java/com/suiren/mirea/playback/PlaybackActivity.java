package com.suiren.mirea.playback;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.*;
import android.os.*;
import android.util.Rational;
import android.view.*;
import android.widget.*;
import androidx.core.content.ContextCompat;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import org.json.*;
import java.util.*;

/** Native surface/custom transport controls; only the video surface remains in PiP. */
public final class PlaybackActivity extends ComponentActivity implements SurfaceHolder.Callback {
    private FrameLayout root;
    private SurfaceView video;
    private LinearLayout top,controls,audioArt;
    private TextView title,time,message;
    private ImageView cover;
    private SeekBar seek;
    private Button play,pip,quality;
    private Switch continuous;
    private boolean visible,preserve,backgroundRequested,scrubbing;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable tick=new Runnable(){public void run(){render();handler.postDelayed(this,500);}};
    private final BroadcastReceiver changed=new BroadcastReceiver(){public void onReceive(Context c,Intent i){render();}};
    private PlaybackService service(){return PlaybackService.current;}
    private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
    private Button button(String text,Runnable action){Button b=new Button(this);b.setText(text);b.setTextColor(Color.WHITE);b.setTextSize(13);b.setOnClickListener(v->action.run());return b;}
    private void rowButton(LinearLayout row,Button b){row.addView(b,new LinearLayout.LayoutParams(0,dp(48),1));}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){public void handleOnBackPressed(){preserve=false;stop();finish();}});setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);
        root=new FrameLayout(this);root.setBackgroundColor(Color.rgb(7,10,20));setContentView(root);
        video=new SurfaceView(this);video.getHolder().addCallback(this);root.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        audioArt=new LinearLayout(this);audioArt.setGravity(Gravity.CENTER);audioArt.setOrientation(LinearLayout.VERTICAL);
        cover=new ImageView(this);cover.setScaleType(ImageView.ScaleType.FIT_CENTER);audioArt.addView(cover,new LinearLayout.LayoutParams(dp(260),dp(260)));
        TextView symbol=new TextView(this);symbol.setText("♫  MIREA / LISTEN");symbol.setTextColor(Color.rgb(210,201,255));symbol.setTextSize(24);symbol.setGravity(Gravity.CENTER);audioArt.addView(symbol);
        root.addView(audioArt,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        top=new LinearLayout(this);top.setOrientation(LinearLayout.VERTICAL);top.setPadding(dp(8),dp(8),dp(8),dp(4));top.setBackgroundColor(0xc0161b2d);
        LinearLayout heading=new LinearLayout(this);Button close=button("← 終了",()->{preserve=false;stop();finish();});heading.addView(close);
        title=new TextView(this);title.setTextColor(Color.WHITE);title.setTextSize(16);title.setMaxLines(2);heading.addView(title,new LinearLayout.LayoutParams(0,-2,1));top.addView(heading);
        message=new TextView(this);message.setTextColor(Color.rgb(215,210,245));top.addView(message);root.addView(top,new FrameLayout.LayoutParams(-1,-2,Gravity.TOP));
        controls=new LinearLayout(this);controls.setOrientation(LinearLayout.VERTICAL);controls.setPadding(dp(8),dp(4),dp(8),dp(8));controls.setBackgroundColor(0xd0121726);
        time=new TextView(this);time.setTextColor(Color.WHITE);controls.addView(time);
        seek=new SeekBar(this);seek.setMax(10000);seek.setContentDescription("再生位置");seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){scrubbing=true;}public void onStopTrackingTouch(SeekBar b){scrubbing=false;PlaybackService s=service();if(s!=null)s.seek(s.duration()*b.getProgress()/10000);}public void onProgressChanged(SeekBar b,int p,boolean user){}});controls.addView(seek);
        LinearLayout transports=new LinearLayout(this);rowButton(transports,button("−10秒",()->{PlaybackService s=service();if(s!=null)s.seek(s.position()-10000);}));
        play=button("再生",()->{PlaybackService s=service();if(s!=null){if(s.playing())s.pause();else s.play();}});rowButton(transports,play);
        rowButton(transports,button("＋10秒",()->{PlaybackService s=service();if(s!=null)s.seek(s.position()+10000);}));rowButton(transports,button("次へ",()->{if(service()!=null)service().navigate(1);}));controls.addView(transports);
        LinearLayout options=new LinearLayout(this);pip=button("PiP",this::enterPip);rowButton(options,pip);
        rowButton(options,button("背景再生",()->{backgroundRequested=true;preserve=true;configurePip(false);moveTaskToBack(true);}));
        quality=button("画質",this::qualities);rowButton(options,quality);
        rowButton(options,button("速度",()->new AlertDialog.Builder(this).setTitle("再生速度").setItems(new String[]{"0.5×","1×","1.25×","1.5×","2×"},(d,index)->{if(service()!=null)service().speed(new float[]{.5f,1,1.25f,1.5f,2}[index]);}).show()));controls.addView(options);
        LinearLayout last=new LinearLayout(this);continuous=new Switch(this);continuous.setText("連続再生");continuous.setTextColor(Color.WHITE);continuous.setOnCheckedChangeListener((b,value)->{if(service()!=null)service().continuous(value);});last.addView(continuous,new LinearLayout.LayoutParams(0,dp(48),1));
        last.addView(button("消音",()->{if(service()!=null)service().mute();}));last.addView(button("ライブラリへ",()->{preserve=true;finish();}));last.addView(button("再接続",()->{if(service()!=null)service().reconnect();}));controls.addView(last);
        root.addView(controls,new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM));
        root.setOnClickListener(v->{if(!isInPictureInPictureMode()){int state=top.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE;top.setVisibility(state);controls.setVisibility(state);}});
        ContextCompat.registerReceiver(this,changed,new IntentFilter(PlaybackService.EVENT),ContextCompat.RECEIVER_NOT_EXPORTED);handler.post(tick);
    }
    private void qualities(){PlaybackService s=service();if(s==null)return;try{JSONArray values=s.status().getJSONArray("qualities");ArrayList<String> names=new ArrayList<>();names.add("元の配信画質");for(int n=0;n<values.length();n++)names.add(values.getJSONObject(n).getString("quality"));new AlertDialog.Builder(this).setTitle("画質").setItems(names.toArray(new String[0]),(d,i)->{PlaybackService target=service();if(target!=null)target.quality(i==0?"legacy":names.get(i));}).show();}catch(Exception ignored){}}
    private String time(long ms){long seconds=ms/1000;return seconds/60+":"+String.format(Locale.ROOT,"%02d",seconds%60);}
    private void render(){PlaybackService s=service();if(s==null){message.setText("再生を終了しました。");play.setEnabled(false);return;}s.visibility(visible&&!isInPictureInPictureMode(),isInPictureInPictureMode());JSONObject status=s.status();JSONObject item=status.optJSONObject("item");title.setText(item==null?"Mirea":item.optString("title"));
        video.setVisibility(s.video()?View.VISIBLE:View.GONE);audioArt.setVisibility(s.video()?View.GONE:View.VISIBLE);
        cover.setImageBitmap(s.artwork);
        play.setEnabled(status.optBoolean("prepared"));play.setText(s.playing()?"一時停止":"再生");seek.setEnabled(status.optBoolean("prepared"));
        if(!scrubbing&&s.duration()>0)seek.setProgress((int)(s.position()*10000/s.duration()));time.setText(time(s.position())+" / "+time(s.duration())+(status.optBoolean("download")?" · 暗号化保存データ":" · ストリーミング"));
        message.setText(!status.optString("error").isEmpty()?status.optString("error"):status.optString("notice"));pip.setVisibility(s.video()?View.VISIBLE:View.GONE);quality.setVisibility(s.video()&&!status.optBoolean("download")?View.VISIBLE:View.GONE);
        if(continuous.isChecked()!=status.optBoolean("continuous"))continuous.setChecked(status.optBoolean("continuous"));
        if(s.video()){int w=status.optInt("width",16),h=status.optInt("height",9);if(w>0&&h>0&&root.getWidth()>0){float scale=Math.min(root.getWidth()/(float)w,root.getHeight()/(float)h);FrameLayout.LayoutParams p=new FrameLayout.LayoutParams(Math.max(1,(int)(w*scale)),Math.max(1,(int)(h*scale)),Gravity.CENTER);video.setLayoutParams(p);}}
        configurePip(!backgroundRequested&&s.video()&&s.playing());
    }
    private boolean canPip(){return getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);}
    private PictureInPictureParams params(boolean auto){PlaybackService s=service();JSONObject state=s==null?new JSONObject():s.status();double ratio=state.optInt("width",16)/(double)Math.max(1,state.optInt("height",9));ratio=Math.max(1/2.39,Math.min(2.39,ratio));
        Rect rect=new Rect();video.getGlobalVisibleRect(rect);PictureInPictureParams.Builder b=new PictureInPictureParams.Builder().setAspectRatio(new Rational((int)(ratio*1000),1000)).setSourceRectHint(rect);
        if(Build.VERSION.SDK_INT>=31)b.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(true);return b.build();}
    private void configurePip(boolean auto){if(canPip()){try{setPictureInPictureParams(params(auto));}catch(IllegalArgumentException ignored){}}}
    private void enterPip(){PlaybackService s=service();if(s==null||!s.video()||!canPip()){Toast.makeText(this,"この端末ではPiPを利用できません。",Toast.LENGTH_SHORT).show();return;}try{enterPictureInPictureMode(params(false));}catch(IllegalStateException|IllegalArgumentException e){Toast.makeText(this,"PiPに切り替えられません。",Toast.LENGTH_SHORT).show();}}
    @Override public void onUserLeaveHint(){super.onUserLeaveHint();PlaybackService s=service();if(Build.VERSION.SDK_INT<31&&!backgroundRequested&&s!=null&&s.video()&&s.playing())enterPip();}
    @Override public void onPictureInPictureModeChanged(boolean value,Configuration config){super.onPictureInPictureModeChanged(value,config);top.setVisibility(value?View.GONE:View.VISIBLE);controls.setVisibility(value?View.GONE:View.VISIBLE);if(service()!=null)service().visibility(!value&&visible,value);}
    @Override public void onResume(){super.onResume();visible=true;backgroundRequested=false;if(service()!=null)service().visibility(true,isInPictureInPictureMode());render();}
    @Override public void onPause(){visible=false;if(service()!=null)service().visibility(false,isInPictureInPictureMode());super.onPause();}
    private void stop(){stopService(new Intent(this,PlaybackService.class));}
    @Override public void onDestroy(){handler.removeCallbacks(tick);try{unregisterReceiver(changed);}catch(Exception ignored){}if(isFinishing()&&!preserve)stop();super.onDestroy();}
    public void surfaceCreated(SurfaceHolder h){if(service()!=null)service().setSurface(h.getSurface());}public void surfaceChanged(SurfaceHolder h,int format,int w,int height){surfaceCreated(h);}public void surfaceDestroyed(SurfaceHolder h){if(service()!=null)service().clearSurface(h.getSurface());}
}
