package com.suiren.mirea.playback;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Color;
import android.view.*;

final class VerticalEqSlider extends androidx.appcompat.widget.AppCompatSeekBar {
    Runnable adjusted;
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    VerticalEqSlider(Context context){super(context);setContentDescription("イコライザー帯域");}
    private float margin(){return 12*getResources().getDisplayMetrics().density;}
    @Override protected synchronized void onDraw(Canvas canvas){float density=getResources().getDisplayMetrics().density,x=getWidth()/2f,top=margin(),bottom=getHeight()-margin(),y=bottom-(bottom-top)*getProgress()/Math.max(1,getMax());paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeWidth(3*density);paint.setColor(Color.rgb(66,78,105));canvas.drawLine(x,top,x,bottom,paint);paint.setColor(Color.rgb(145,130,190));paint.setStrokeWidth(density);canvas.drawLine(x-5*density,(top+bottom)/2,x+5*density,(top+bottom)/2,paint);paint.setStrokeWidth(3*density);paint.setColor(isEnabled()?Color.rgb(184,172,255):Color.GRAY);canvas.drawLine(x,y,x,bottom,paint);canvas.drawCircle(x,y,6*density,paint);}
    @Override public boolean onTouchEvent(MotionEvent event){if(!isEnabled())return false;switch(event.getActionMasked()){case MotionEvent.ACTION_DOWN:case MotionEvent.ACTION_MOVE:case MotionEvent.ACTION_UP:getParent().requestDisallowInterceptTouchEvent(true);float length=Math.max(1,getHeight()-2*margin());setProgress(Math.max(0,Math.min(getMax(),Math.round(getMax()*(1-(event.getY()-margin())/length)))));if(adjusted!=null)adjusted.run();invalidate();if(event.getActionMasked()==MotionEvent.ACTION_UP){performClick();getParent().requestDisallowInterceptTouchEvent(false);}return true;case MotionEvent.ACTION_CANCEL:getParent().requestDisallowInterceptTouchEvent(false);return true;default:return super.onTouchEvent(event);}}
    @Override public boolean onKeyDown(int key,KeyEvent event){if(key==KeyEvent.KEYCODE_DPAD_UP||key==KeyEvent.KEYCODE_DPAD_DOWN){setProgress(Math.max(0,Math.min(getMax(),getProgress()+(key==KeyEvent.KEYCODE_DPAD_UP?1:-1))));if(adjusted!=null)adjusted.run();invalidate();return true;}return super.onKeyDown(key,event);}
    @Override public boolean performClick(){super.performClick();return true;}
}
