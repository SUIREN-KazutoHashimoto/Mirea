package com.suiren.mirea.playback;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.text.TextUtils;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;

/** Responsive native presentation only. Playback, grants, progress and analytics stay in the service. */
public final class PlaybackScreen extends FrameLayout {
    public interface Actions {void perform(String action);void seek(long position);void scrub(boolean value);default void boost(boolean value){}}
    private final android.os.Handler holdHandler=new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean holdPending,holdTriggered,holdConsumed;
    private float holdX,holdY;
    private final Runnable holdStart=this::beginHold;
    private final ReplayHeatmapView heatmap;
    private final TextView boostBadge;
    private static final int WHITE=0xfff5f7ff,MUTED=0xffa6b0cb,ACCENT=0xffb3c2ff;
    private final Actions actions;
    private final LinearLayout header,videoFooter,videoTransport,audioDetails,audioTransport;
    private final FrameLayout audioBody,artSpace,artCard,center;
    private final ImageView cover;
    private final ImageButton videoPlay,audioPlay,rotate;
    private final TextView headerTitle,audioEyebrow,audioTitle,audioMeta,videoTime,audioTime,videoNote,audioNote,quality,speed,errorText;
    private final SeekBar videoSeek,audioSeek;
    private final ProgressBar loading;
    private final LinearLayout errorCard;
    private boolean isVideo=true,chrome=true,pip,scrubbing,scrubCancelled;
    private Boolean audioWide;
    private int insetLeft,insetTop,insetRight,insetBottom;
    private JSONObject model=new JSONObject();
    private Bitmap artwork;
    private long duration;

    public PlaybackScreen(Context context,Actions actions){
        super(context);this.actions=actions;setTag("playback-screen");setOnClickListener(v->{if(isVideo)actions.perform("toggle-chrome");});
        audioBody=new FrameLayout(context);addView(audioBody,new LayoutParams(-1,-1));audioBody.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->{if(r-l!=or-ol||b-t!=ob-ot)post(this::layoutAudio);});
        artSpace=new FrameLayout(context);artSpace.setMinimumHeight(dp(156));
        artCard=new FrameLayout(context);artCard.setTag("audio-artwork");artCard.setBackground(round(0xff233356,18));artCard.setClipToOutline(true);artCard.setElevation(dp(8));
        ImageView fallback=new ImageView(context);fallback.setImageDrawable(new PlaybackIcon("music",ACCENT));fallback.setPadding(dp(55),dp(55),dp(55),dp(55));artCard.addView(fallback,new LayoutParams(-1,-1));
        cover=new ImageView(context);cover.setScaleType(ImageView.ScaleType.FIT_CENTER);artCard.addView(cover,new LayoutParams(-1,-1));artSpace.addView(artCard,new LayoutParams(dp(144),dp(144),Gravity.CENTER));
        artSpace.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->resizeArtwork());
        audioDetails=column();audioDetails.setPadding(dp(24),dp(12),dp(24),dp(12));
        audioEyebrow=text("MIREA / AUDIO",11,ACCENT);audioEyebrow.setLetterSpacing(.18f);audioDetails.addView(audioEyebrow);
        audioTitle=text("Mirea",25,WHITE);audioTitle.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));audioTitle.setMaxLines(2);audioTitle.setEllipsize(TextUtils.TruncateAt.END);audioTitle.setTag("audio-title");audioTitle.setAccessibilityHeading(true);LinearLayout.LayoutParams titleParams=linear(-1,-2);titleParams.topMargin=dp(10);audioDetails.addView(audioTitle,titleParams);
        audioMeta=text("ストリーミング",12,MUTED);LinearLayout.LayoutParams metaParams=linear(-1,-2);metaParams.topMargin=dp(8);audioDetails.addView(audioMeta,metaParams);
        audioNote=text("",12,ACCENT);audioDetails.addView(audioNote,linear(-1,-2));
        audioSeek=seek("audio-seek");LinearLayout.LayoutParams seekParams=linear(-1,dp(48));seekParams.topMargin=dp(10);audioDetails.addView(audioSeek,seekParams);
        audioTime=text("0:00 / 0:00",12,MUTED);audioTime.setTypeface(Typeface.MONOSPACE);audioTime.setGravity(Gravity.END);audioDetails.addView(audioTime,linear(-1,-2));
        audioTransport=new LinearLayout(context);audioTransport.setGravity(Gravity.CENTER_VERTICAL);audioTransport.setTag("audio-transport");
        addWeighted(audioTransport,icon("previous","前の作品","previous",48),64);
        addWeighted(audioTransport,icon("rewind","10秒戻る","rewind",48),64);
        audioPlay=icon("play","再生","play",72);audioPlay.setBackground(ripple(round(ACCENT,36)));audioPlay.setImageDrawable(new PlaybackIcon("play",0xff142039));LinearLayout.LayoutParams audioPlayParams=linear(dp(72),dp(72));audioPlayParams.setMargins(dp(4),0,dp(4),0);audioTransport.addView(audioPlay,audioPlayParams);
        addWeighted(audioTransport,icon("forward","10秒進む","forward",48),64);
        addWeighted(audioTransport,icon("next","次の作品","next",48),64);
        LinearLayout.LayoutParams transportParams=linear(-1,dp(92));transportParams.topMargin=dp(8);audioDetails.addView(audioTransport,transportParams);
        TextView background=chip("バックグラウンドで再生","background");background.setCompoundDrawablePadding(dp(9));PlaybackIcon headphones=new PlaybackIcon("background",ACCENT);headphones.setBounds(0,0,dp(19),dp(19));background.setCompoundDrawables(headphones,null,null,null);background.setTag("audio-background");audioDetails.addView(background,linear(-1,dp(48)));

        header=new LinearLayout(context);header.setGravity(Gravity.CENTER_VERTICAL);header.setTag("player-header");
        header.addView(icon("close","再生を終了して戻る","close",48),linear(dp(48),dp(48)));
        headerTitle=text("Mirea",16,WHITE);headerTitle.setMaxLines(1);headerTitle.setEllipsize(TextUtils.TruncateAt.END);header.addView(headerTitle,new LinearLayout.LayoutParams(0,-2,1));
        rotate=icon("rotate","縦／横画面を切り替え","rotate",48);rotate.setTag("player-rotate");header.addView(rotate,linear(dp(48),dp(48)));
        ImageButton more=icon("more","再生オプション","options",48);more.setTag("player-options");header.addView(more,linear(dp(48),dp(48)));addView(header,new LayoutParams(-1,dp(72),Gravity.TOP));

        center=new FrameLayout(context);videoTransport=new LinearLayout(context);videoTransport.setGravity(Gravity.CENTER);videoTransport.setTag("video-transport");
        videoTransport.addView(icon("rewind","10秒戻る","rewind",56),linear(dp(64),dp(64)));
        videoPlay=icon("play","再生","play",72);videoPlay.setBackground(ripple(round(0xc028354c,40)));LinearLayout.LayoutParams videoPlayParams=linear(dp(80),dp(80));videoPlayParams.setMargins(dp(24),0,dp(24),0);videoTransport.addView(videoPlay,videoPlayParams);
        videoTransport.addView(icon("forward","10秒進む","forward",56),linear(dp(64),dp(64)));center.addView(videoTransport,new LayoutParams(-2,-2,Gravity.CENTER));
        loading=new ProgressBar(context);loading.setIndeterminateTintList(ColorStateList.valueOf(ACCENT));center.addView(loading,new LayoutParams(dp(38),dp(38),Gravity.CENTER));addView(center,new LayoutParams(-1,dp(100),Gravity.CENTER));

        videoFooter=column();videoFooter.setTag("video-footer");videoFooter.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0x0007101a,0xe607101a}));
        videoNote=text("",12,ACCENT);videoFooter.addView(videoNote,linear(-1,-2));
        heatmap=new ReplayHeatmapView(context);videoFooter.addView(heatmap,linear(-1,dp(36)));
        videoSeek=seek("video-seek");videoFooter.addView(videoSeek,linear(-1,dp(44)));
        LinearLayout videoBottom=new LinearLayout(context);videoBottom.setGravity(Gravity.CENTER_VERTICAL);videoTime=text("0:00 / 0:00",13,WHITE);videoTime.setTypeface(Typeface.MONOSPACE);videoTime.setMaxLines(1);videoTime.setEllipsize(TextUtils.TruncateAt.END);videoBottom.addView(videoTime,new LinearLayout.LayoutParams(0,-2,1));
        quality=chip("標準","quality");quality.setTag("player-quality");videoBottom.addView(quality,linear(-2,dp(48)));
        speed=chip("1×","speed");videoBottom.addView(speed,linear(dp(52),dp(48)));ImageButton next=icon("next","次の作品","next",48);videoBottom.addView(next,linear(dp(48),dp(48)));videoFooter.addView(videoBottom,linear(-1,-2));addView(videoFooter,new LayoutParams(-1,-2,Gravity.BOTTOM));

        errorCard=column();errorCard.setGravity(Gravity.CENTER);errorCard.setPadding(dp(24),dp(20),dp(24),dp(20));errorCard.setBackground(round(0xee152038,18));errorCard.setTag("player-error");errorCard.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        errorText=text("",14,WHITE);errorText.setMaxWidth(dp(440));errorText.setGravity(Gravity.CENTER);errorCard.addView(errorText,linear(-2,-2));TextView retry=chip("再接続する","reconnect");LinearLayout.LayoutParams retryParams=linear(-2,dp(48));retryParams.topMargin=dp(12);errorCard.addView(retry,retryParams);LayoutParams errorParams=new LayoutParams(-2,-2,Gravity.CENTER);errorParams.setMargins(dp(24),dp(72),dp(24),dp(120));addView(errorCard,errorParams);
        boostBadge=text("▶▶ 2× 早送り",14,WHITE);boostBadge.setTag("hold-boost");boostBadge.setGravity(Gravity.CENTER);boostBadge.setBackground(round(0xdd152038,24));boostBadge.setPadding(dp(18),dp(8),dp(18),dp(8));boostBadge.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);LayoutParams badgeParams=new LayoutParams(-2,-2,Gravity.TOP|Gravity.CENTER_HORIZONTAL);badgeParams.topMargin=dp(84);addView(boostBadge,badgeParams);boostBadge.setVisibility(GONE);
        setSafeInsets(0,0,0,0);bind(new JSONObject(),null);setVideo(true);
    }
    private void beginHold(){if(holdPending){holdPending=false;holdTriggered=true;holdConsumed=true;setPressed(false);actions.boost(true);}}
    public void cancelHold(){holdHandler.removeCallbacks(holdStart);holdPending=false;if(holdTriggered){holdTriggered=false;actions.boost(false);}}
    @Override public boolean onTouchEvent(MotionEvent event){
        int action=event.getActionMasked();
        if(action==MotionEvent.ACTION_DOWN){cancelHold();holdConsumed=false;holdX=event.getX();holdY=event.getY();if(isVideo&&model.optBoolean("playing")&&!model.optBoolean("buffering")){holdPending=true;holdHandler.postDelayed(holdStart,ViewConfiguration.getLongPressTimeout());}}
        else if(action==MotionEvent.ACTION_MOVE){int slop=ViewConfiguration.get(getContext()).getScaledTouchSlop();if(Math.hypot(event.getX()-holdX,event.getY()-holdY)>slop){holdConsumed=true;cancelHold();}}
        else if(action==MotionEvent.ACTION_POINTER_DOWN){holdConsumed=true;cancelHold();}
        else if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL){boolean consumed=holdConsumed;cancelHold();if(consumed||action==MotionEvent.ACTION_CANCEL){setPressed(false);cancelPendingInputEvents();return true;}}
        return super.onTouchEvent(event);
    }
    @Override protected void onDetachedFromWindow(){cancelHold();cancelScrub();super.onDetachedFromWindow();}
    public void cancelScrub(){heatmap.setSeeking(false);if(scrubbing){scrubCancelled=true;scrubbing=false;actions.scrub(false);}}
    private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
    private LinearLayout column(){LinearLayout value=new LinearLayout(getContext());value.setOrientation(LinearLayout.VERTICAL);return value;}
    private static LinearLayout.LayoutParams linear(int width,int height){return new LinearLayout.LayoutParams(width,height);}
    private TextView text(String value,int size,int color){TextView t=new TextView(getContext());t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setFontFeatureSettings("tnum");return t;}
    private GradientDrawable round(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private RippleDrawable ripple(Drawable background){return new RippleDrawable(ColorStateList.valueOf(0x334f78ff),background,round(Color.WHITE,40));}
    private ImageButton icon(String icon,String description,String action,int size){
        ImageButton b=new ImageButton(getContext());b.setTag("action-"+action);b.setContentDescription(description);b.setImageDrawable(new PlaybackIcon(icon,WHITE));b.setScaleType(ImageView.ScaleType.FIT_CENTER);int padding=dp(size>=72?23:13);b.setPadding(padding,padding,padding,padding);b.setMinimumWidth(dp(48));b.setMinimumHeight(dp(48));b.setBackground(ripple(round(0x182f4265,32)));b.setOnClickListener(v->actions.perform(action));return b;
    }
    private TextView chip(String label,String action){TextView b=text(label,13,WHITE);b.setGravity(Gravity.CENTER);b.setPadding(dp(12),0,dp(12),0);b.setMinWidth(dp(48));b.setMinHeight(dp(48));b.setBackground(ripple(round(0x182f4265,12)));b.setContentDescription(label);b.setFocusable(true);b.setAccessibilityDelegate(new View.AccessibilityDelegate(){@Override public void onInitializeAccessibilityNodeInfo(View host,android.view.accessibility.AccessibilityNodeInfo info){super.onInitializeAccessibilityNodeInfo(host,info);info.setClassName(Button.class.getName());}});b.setOnClickListener(v->actions.perform(action));return b;}
    private void addWeighted(LinearLayout row,View view,int height){row.addView(view,new LinearLayout.LayoutParams(0,dp(height),1));}
    private SeekBar seek(String tag){SeekBar value=new SeekBar(getContext());value.setTag(tag);value.setMax(10000);value.setContentDescription("再生位置");value.setProgressTintList(ColorStateList.valueOf(ACCENT));value.setThumbTintList(ColorStateList.valueOf(ACCENT));value.setProgressBackgroundTintList(ColorStateList.valueOf(0x554a5b7d));value.setPadding(dp(4),0,dp(4),0);
        value.setOnTouchListener((v,event)->{if(event.getActionMasked()==MotionEvent.ACTION_DOWN)scrubCancelled=false;else if(event.getActionMasked()==MotionEvent.ACTION_CANCEL){scrubCancelled=true;cancelScrub();}return false;});
        value.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){scrubbing=true;heatmap.setSeeking(isVideo&&b==videoSeek);actions.scrub(true);}public void onStopTrackingTouch(SeekBar b){boolean commit=!scrubCancelled;scrubbing=false;heatmap.setSeeking(false);if(commit)actions.seek(duration*b.getProgress()/10000);actions.scrub(false);}public void onProgressChanged(SeekBar b,int progress,boolean user){if(user){String label=PlaybackPresentation.time(duration*progress/10000)+" / "+PlaybackPresentation.time(duration);videoTime.setText(label);audioTime.setText(label);}}});return value;
    }
    public void setSafeInsets(int left,int top,int right,int bottom){
        insetLeft=left;insetTop=top;insetRight=right;insetBottom=bottom;
        header.setPadding(left+dp(12),top+dp(8),right+dp(12),dp(8));header.getLayoutParams().height=top+dp(64);
        videoFooter.setPadding(left+dp(20),dp(16),right+dp(20),bottom+dp(8));
        LayoutParams a=(LayoutParams)audioBody.getLayoutParams();a.setMargins(left,top+dp(68),right,bottom+dp(4));audioBody.setLayoutParams(a);requestLayout();
    }
    public void setVideo(boolean value){
        if(isVideo!=value)cancelScrub();
        if(isVideo!=value||audioWide==null){isVideo=value;audioBody.setVisibility(value?GONE:VISIBLE);rotate.setVisibility(value?VISIBLE:GONE);setBackground(value?null:new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xff23375b,0xff111b31,0xff080e1b}));header.setBackground(value?new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xd908101d,0x0008101d}):null);}
        updateVisibility();
    }
    public void setChromeVisible(boolean value){if(!value)cancelScrub();chrome=value;updateVisibility();}
    public void setPip(boolean value){if(value)cancelScrub();pip=value;setVisibility(value?GONE:VISIBLE);}
    public void landscape(boolean value){rotate.setContentDescription(value?"縦画面に切り替え":"横画面に切り替え");}
    private void updateVisibility(){header.setVisibility(!isVideo||chrome?VISIBLE:GONE);center.setVisibility(isVideo&&chrome?VISIBLE:GONE);videoFooter.setVisibility(isVideo&&chrome?VISIBLE:GONE);}
    public void bind(JSONObject value,Bitmap image){
        model=value;boolean video=value.optBoolean("video"),prepared=value.optBoolean("prepared"),playing=value.optBoolean("playing"),busy=value.optBoolean("buffering");setVideo(video);
        if(!prepared||!value.optString("error").isEmpty())cancelScrub();
        if(!video||!playing||busy||!value.optString("error").isEmpty())cancelHold();heatmap.bind(video?value.optJSONObject("heatmap"):null);boostBadge.setVisibility(video&&value.optBoolean("holdBoost")?VISIBLE:GONE);
        JSONObject item=value.optJSONObject("item");String name=item==null?"Mirea":item.optString("title","Mirea");headerTitle.setText(video?name:"再生中");audioTitle.setText(name);
        if(artwork!=image){artwork=image;cover.setImageBitmap(image);}cover.setVisibility(image==null?GONE:VISIBLE);
        duration=value.optLong("durationMs");long position=value.optLong("positionMs");String label=PlaybackPresentation.time(position)+" / "+PlaybackPresentation.time(duration);if(!scrubbing){videoTime.setText(label);audioTime.setText(label);int p=duration>0?(int)Math.max(0,Math.min(10000,position*10000/duration)):0;videoSeek.setProgress(p);audioSeek.setProgress(p);}
        for(ImageButton button:new ImageButton[]{videoPlay,audioPlay}){button.setEnabled(prepared);button.setAlpha(prepared?1f:.45f);button.setContentDescription(playing?"一時停止":"再生");button.setImageDrawable(new PlaybackIcon(playing?"pause":"play",button==audioPlay?0xff142039:WHITE));}
        videoSeek.setEnabled(prepared);audioSeek.setEnabled(prepared);String selected=value.optString("quality","legacy"),qualityLabel=selected.equals("legacy")?"標準":selected+" 固定";quality.setText(qualityLabel);quality.setContentDescription("画質："+qualityLabel);quality.setVisibility(video&&!value.optBoolean("download")?VISIBLE:GONE);speed.setText(String.format(java.util.Locale.ROOT,"%s×",value.optDouble("rate",1)) .replace(".0×","×"));
        String source=value.optBoolean("download")?"暗号化保存データ":"ストリーミング";audioMeta.setText(source+(busy?" · 読み込み中…":""));String notice=value.optString("notice");audioNote.setText(notice);audioNote.setVisibility(notice.isEmpty()?GONE:VISIBLE);videoNote.setText(notice);videoNote.setVisibility(notice.isEmpty()?GONE:VISIBLE);
        String error=value.optString("error");if(!error.equals(errorText.getText().toString()))errorText.setText(error);errorCard.setVisibility(error.isEmpty()?GONE:VISIBLE);loading.setVisibility(video&&busy&&error.isEmpty()?VISIBLE:GONE);videoPlay.setVisibility(busy?INVISIBLE:VISIBLE);videoTransport.setVisibility(error.isEmpty()&&!value.optBoolean("holdBoost")?VISIBLE:INVISIBLE);
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);speed.setVisibility(w>=dp(480)&&getResources().getConfiguration().fontScale<1.5f?VISIBLE:GONE);post(this::layoutAudio);}
    @Override protected void onMeasure(int widthSpec,int heightSpec){super.onMeasure(widthSpec,heightSpec);if(isVideo&&chrome){int height=Math.max(0,getMeasuredHeight()-header.getMeasuredHeight()-videoFooter.getMeasuredHeight());center.measure(MeasureSpec.makeMeasureSpec(getMeasuredWidth(),MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(height,MeasureSpec.EXACTLY));}}
    @Override protected void onLayout(boolean changed,int l,int t,int r,int b){super.onLayout(changed,l,t,r,b);if(isVideo&&chrome)center.layout(0,header.getBottom(),r-l,Math.max(header.getBottom(),videoFooter.getTop()));}
    private void detach(View v){if(v.getParent() instanceof android.view.ViewGroup)((android.view.ViewGroup)v.getParent()).removeView(v);}
    private void layoutAudio(){
        if(audioBody.getWidth()==0||audioBody.getHeight()==0)return;boolean wide=audioBody.getWidth()>audioBody.getHeight()*1.2;
        int detailsWidth=wide?Math.round(audioBody.getWidth()*.58f):audioBody.getWidth(),padding=detailsWidth<dp(320)?dp(8):dp(24);audioDetails.setPadding(padding,dp(wide?4:12),padding,dp(wide?4:12));boolean compact=detailsWidth-2*padding<dp(272);audioTransport.getChildAt(0).setVisibility(compact?GONE:VISIBLE);audioTransport.getChildAt(4).setVisibility(compact?GONE:VISIBLE);
        if(audioWide!=null&&audioWide==wide){if(!wide)sizePortraitArt();return;}audioWide=wide;detach(artSpace);detach(audioDetails);audioBody.removeAllViews();
        audioEyebrow.setVisibility(wide?GONE:VISIBLE);audioTitle.setTextSize(wide?20:25);audioTitle.setMaxLines(wide?1:2);audioTime.setTextSize(wide?11:12);
        LinearLayout.LayoutParams titleP=(LinearLayout.LayoutParams)audioTitle.getLayoutParams();titleP.topMargin=dp(wide?0:10);audioTitle.setLayoutParams(titleP);LinearLayout.LayoutParams metaP=(LinearLayout.LayoutParams)audioMeta.getLayoutParams();metaP.topMargin=dp(wide?4:8);audioMeta.setLayoutParams(metaP);
        LinearLayout.LayoutParams seekP=(LinearLayout.LayoutParams)audioSeek.getLayoutParams();seekP.height=dp(wide?44:48);seekP.topMargin=dp(wide?4:10);audioSeek.setLayoutParams(seekP);LinearLayout.LayoutParams transportP=(LinearLayout.LayoutParams)audioTransport.getLayoutParams();transportP.height=dp(wide?72:92);transportP.topMargin=dp(wide?0:8);audioTransport.setLayoutParams(transportP);
        if(wide){LinearLayout row=new LinearLayout(getContext());row.setGravity(Gravity.CENTER_VERTICAL);row.addView(artSpace,new LinearLayout.LayoutParams(0,-1,.42f));ScrollView scroll=new ScrollView(getContext());scroll.setFillViewport(true);scroll.addView(audioDetails,new ScrollView.LayoutParams(-1,-2));row.addView(scroll,new LinearLayout.LayoutParams(0,-1,.58f));audioBody.addView(row,new LayoutParams(-1,-1));}
        else{ScrollView scroll=new ScrollView(getContext());scroll.setTag("audio-scroll");scroll.setFillViewport(true);LinearLayout col=column();col.setGravity(Gravity.CENTER_VERTICAL);col.addView(artSpace,linear(-1,dp(156)));col.addView(audioDetails,linear(-1,-2));scroll.addView(col,new ScrollView.LayoutParams(-1,-2));audioBody.addView(scroll,new LayoutParams(-1,-1));sizePortraitArt();}
        requestLayout();
    }
    private void sizePortraitArt(){audioDetails.measure(MeasureSpec.makeMeasureSpec(audioBody.getWidth(),MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED));int desired=Math.max(dp(156),Math.min(dp(380),audioBody.getHeight()-audioDetails.getMeasuredHeight()));ViewGroup.LayoutParams p=artSpace.getLayoutParams();if(p.height!=desired){p.height=desired;artSpace.setLayoutParams(p);}}
    private void resizeArtwork(){int size=Math.max(dp(96),Math.min(dp(360),Math.min(artSpace.getWidth()-dp(48),artSpace.getHeight()-dp(24))));LayoutParams p=(LayoutParams)artCard.getLayoutParams();if(p.width!=size){p.width=size;p.height=size;artCard.setLayoutParams(p);}}
}
