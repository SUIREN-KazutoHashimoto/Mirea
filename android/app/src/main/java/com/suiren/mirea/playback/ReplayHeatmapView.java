package com.suiren.mirea.playback;

import android.content.Context;
import android.graphics.*;
import android.view.View;
import org.json.*;

/** Normalized, thresholded server data only; this view never sees raw histories. */
public final class ReplayHeatmapView extends View {
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    private JSONObject model;
    private JSONArray points;
    private long duration,bin;
    private int peak;
    private boolean personal;
    public ReplayHeatmapView(Context context){super(context);setTag("replay-heatmap");setVisibility(GONE);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);}
    public void bind(JSONObject value){
        if(model==value)return;model=value;points=null;
        try{
            if(value==null||!value.optBoolean("available")||!("anonymous".equals(value.optString("scope"))||"self".equals(value.optString("scope"))))throw new JSONException("Unavailable");personal="self".equals(value.optString("scope"));
            JSONArray data=value.getJSONArray("points");duration=value.getLong("durationMs");bin=value.getLong("binSizeMs");
            if(duration<=0||bin<10000||data.length()==0||data.length()>200||data.length()!=Math.ceil(duration/(double)bin))throw new JSONException("Bounds");
            peak=-1;
            for(int i=0;i<data.length();i++)if(!data.isNull(i)){double p=data.getDouble(i);if(!Double.isFinite(p)||p<0||p>1)throw new JSONException("Invalid point");if(p>0&&(peak<0||p>data.getDouble(peak)))peak=i;}
            if(peak<0)throw new JSONException("Empty");points=data;setContentDescription(label());
        }catch(JSONException ignored){}
        setVisibility(points==null?GONE:VISIBLE);invalidate();
    }
    private String label(){return (personal?"自分の再生傾向":"よく再生されている箇所（匿名集計）")+" · "+PlaybackPresentation.time(peak*bin);}
    @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);if(points==null)return;float density=getResources().getDisplayMetrics().density,left=4*density,width=getWidth()-8*density,base=getHeight();paint.setColor(0xffdce2ef);paint.setTextSize(10*getResources().getDisplayMetrics().scaledDensity);canvas.drawText(label(),left,paint.getTextSize(),paint);paint.setColor(0x99c4ccdf);float height=Math.max(0,base-paint.getTextSize()-6*density);for(int i=0;i<points.length();i++)if(!points.isNull(i)){float x=left+width*i*bin/duration,right=left+width*Math.min(duration,(i+1)*bin)/duration;canvas.drawRect(x,base-height*(float)points.optDouble(i),right,base,paint);}}
}
