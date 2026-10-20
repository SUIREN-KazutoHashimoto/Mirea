package com.suiren.mirea.playback;

import android.graphics.*;
import android.graphics.drawable.Drawable;

/** Small code-native line icons: no system-theme button chrome or raster assets. */
final class PlaybackIcon extends Drawable {
    private final String name;private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);private int color;
    PlaybackIcon(String name,int color){this.name=name;this.color=color;}
    private void path(Canvas c,float... xy){Path p=new Path();p.moveTo(xy[0],xy[1]);for(int n=2;n<xy.length;n+=2)p.lineTo(xy[n],xy[n+1]);c.drawPath(p,paint);}
    @Override public void draw(Canvas canvas){
        canvas.save();canvas.translate(getBounds().left,getBounds().top);canvas.scale(getBounds().width()/24f,getBounds().height()/24f);
        paint.setColor(color);paint.setStrokeWidth(1.8f);paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeJoin(Paint.Join.ROUND);paint.setStyle(Paint.Style.STROKE);
        switch(name){
            case "close":path(canvas,6,6,18,18);path(canvas,18,6,6,18);break;
            case "more":paint.setStyle(Paint.Style.FILL);for(int y=5;y<=19;y+=7)canvas.drawCircle(12,y,1.6f,paint);break;
            case "play":case "next":case "previous":{
                boolean previous=name.equals("previous");if(previous){canvas.translate(24,0);canvas.scale(-1,1);}paint.setStyle(Paint.Style.FILL);path(canvas,8,5,19,12,8,19,8,5);if(!name.equals("play")){paint.setStyle(Paint.Style.STROKE);path(canvas,21,5,21,19);}break;
            }
            case "pause":paint.setStyle(Paint.Style.FILL);canvas.drawRoundRect(6,5,10,19,1,1,paint);canvas.drawRoundRect(14,5,18,19,1,1,paint);break;
            case "rewind":case "forward":{
                if(name.equals("forward")){canvas.translate(24,0);canvas.scale(-1,1);}canvas.drawArc(3,3,21,21,-70,285,false,paint);path(canvas,4,3,4,8,9,8);
                if(name.equals("forward")){canvas.translate(24,0);canvas.scale(-1,1);}paint.setStyle(Paint.Style.FILL);paint.setTextSize(8);paint.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));paint.setTextAlign(Paint.Align.CENTER);canvas.drawText("10",12,15,paint);break;
            }
            case "rotate":canvas.drawRoundRect(7,3,17,21,2,2,paint);path(canvas,2,10,2,6,5,6);path(canvas,22,14,22,18,19,18);path(canvas,2,6,5,3);path(canvas,22,18,19,21);break;
            case "pip":canvas.drawRoundRect(2,4,22,20,2,2,paint);paint.setStyle(Paint.Style.FILL);canvas.drawRoundRect(12,12,20,18,1,1,paint);break;
            case "background":canvas.drawArc(4,3,20,21,180,180,false,paint);canvas.drawRoundRect(3,11,7,20,2,2,paint);canvas.drawRoundRect(17,11,21,20,2,2,paint);break;
            case "music":path(canvas,9,18,9,5,20,3,20,16);path(canvas,9,8,20,6);paint.setStyle(Paint.Style.FILL);canvas.drawOval(3,16,9,21,paint);canvas.drawOval(14,14,20,19,paint);break;
            default:canvas.drawCircle(12,12,8,paint);
        }
        canvas.restore();
    }
    @Override public void setAlpha(int alpha){paint.setAlpha(alpha);invalidateSelf();}
    @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);invalidateSelf();}
    @Override public int getIntrinsicWidth(){return 24;}
    @Override public int getIntrinsicHeight(){return 24;}
    @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
}
