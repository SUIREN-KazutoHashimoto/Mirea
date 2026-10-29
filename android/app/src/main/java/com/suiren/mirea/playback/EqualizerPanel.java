package com.suiren.mirea.playback;
import android.content.Context;
import android.view.View;
import android.widget.*;
import org.json.*;

/** Slider edits affect the existing service; opening this view never opens a new player. */
final class EqualizerPanel extends ScrollView {
    interface Change {JSONObject apply(boolean enabled,double[] gains);}
    private final TextView note;private final CheckBox enabled;private final double[] gains=new double[5];private final Change changed;
    EqualizerPanel(Context context,JSONObject state,Change changed){
        super(context);this.changed=changed;if(state==null)state=new JSONObject();
        LinearLayout body=new LinearLayout(context);body.setOrientation(LinearLayout.VERTICAL);int pad=(int)(20*getResources().getDisplayMetrics().density);body.setPadding(pad,pad/2,pad,pad);addView(body);
        enabled=new CheckBox(context);enabled.setTag("eq-enabled");enabled.setText("有効にする");enabled.setChecked(state.optBoolean("enabled"));body.addView(enabled);
        Spinner preset=new Spinner(context);preset.setTag("eq-preset");String[] names={"カスタム","フラット","低音を強調","声を聴きやすく","高音を明瞭に"};double[][] values={{0,0,0,0,0},{0,0,0,0,0},{6,3,0,-1,-2},{-3,-2,4,3,-2},{-2,-1,0,3,5}};preset.setAdapter(new ArrayAdapter<>(context,android.R.layout.simple_spinner_dropdown_item,names));body.addView(preset);
        SeekBar[] sliders=new SeekBar[5];JSONArray stored=state.optJSONArray("gains");boolean[] ready={false};
        for(int i=0;i<5;i++){
            final int index=i;gains[i]=PlaybackEqualizer.clamp(stored==null?0:stored.optDouble(i,0));TextView label=new TextView(context);body.addView(label);SeekBar slider=new SeekBar(context);sliders[i]=slider;slider.setTag("eq-band-"+i);slider.setMax(48);slider.setProgress((int)Math.round((gains[i]+12)*2));slider.setMinimumHeight((int)(48*getResources().getDisplayMetrics().density));slider.setContentDescription(PlaybackEqualizer.FREQUENCIES[i]+" Hz");body.addView(slider);label.setText(label(i,gains[i]));
            slider.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,(int)(48*getResources().getDisplayMetrics().density)));slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){}public void onStopTrackingTouch(SeekBar b){}public void onProgressChanged(SeekBar b,int value,boolean user){gains[index]=value/2d-12;label.setText(label(index,gains[index]));if(user){preset.setSelection(0);apply();}}});
        }
        TextView help=new TextView(context);help.setPadding(0,pad/2,0,pad/2);help.setText("動画・音楽で共通。この端末に保存します。音割れを抑えるため出力を調整します。");body.addView(help);note=new TextView(context);note.setTag("eq-status");body.addView(note);
        enabled.setOnCheckedChangeListener((v,value)->apply());preset.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> a){}public void onItemSelected(AdapterView<?> a,View v,int position,long id){if(!ready[0]||position==0)return;for(int i=0;i<5;i++)sliders[i].setProgress((int)((values[position][i]+12)*2));apply();}});preset.post(()->ready[0]=true);status(state);
    }
    private static String label(int i,double gain){int f=PlaybackEqualizer.FREQUENCIES[i];return (f>=1000?f/1000d+" kHz":f+" Hz")+" · "+(gain>0?"+":"")+gain+" dB";}
    private void apply(){status(changed.apply(enabled.isChecked(),gains.clone()));}
    void status(JSONObject state){if(state==null)return;String message=state.optString("notice");note.setText(!message.isEmpty()?message:!state.optBoolean("enabled")?"イコライザーはオフです。":state.optBoolean("available")?"イコライザーを適用中":"再生開始後に適用します。");}
}
