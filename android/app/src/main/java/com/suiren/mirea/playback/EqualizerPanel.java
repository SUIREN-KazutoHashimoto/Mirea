package com.suiren.mirea.playback;
import android.content.Context;
import android.view.View;
import android.widget.*;
import org.json.*;

final class EqualizerPanel extends ScrollView {
    interface Change {JSONObject apply(boolean enabled,double[] gains);}
    private final TextView note;private final CheckBox enabled;private final double[] gains=new double[PlaybackEqualizer.FREQUENCIES.length];private final Change changed;
    EqualizerPanel(Context context,JSONObject state,Change changed){
        super(context);this.changed=changed;if(state==null)state=new JSONObject();float density=getResources().getDisplayMetrics().density;int pad=(int)(20*density);
        LinearLayout body=new LinearLayout(context);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(pad,pad/2,pad,pad);addView(body);
        enabled=new CheckBox(context);enabled.setTag("eq-enabled");enabled.setText("有効にする");enabled.setChecked(state.optBoolean("enabled"));body.addView(enabled);
        Spinner preset=new Spinner(context);preset.setTag("eq-preset");String[] names={"カスタム","フラット","低音を強調","声を聴きやすく","高音を明瞭に"};preset.setAdapter(new ArrayAdapter<>(context,android.R.layout.simple_spinner_dropdown_item,names));body.addView(preset);
        TextView axis=new TextView(context);axis.setText("低音 ← 周波数 → 高音 · ±12 dB\n横にスワイプして帯域を選べます");axis.setPadding(0,pad/2,0,pad/2);body.addView(axis);
        HorizontalScrollView bank=new HorizontalScrollView(context);bank.setTag("eq-bank");LinearLayout row=new LinearLayout(context);row.setOrientation(LinearLayout.HORIZONTAL);bank.addView(row);body.addView(bank);
        SeekBar[] sliders=new SeekBar[gains.length];JSONArray stored=state.optJSONArray("gains");double[] input=new double[stored==null?0:stored.length()];for(int i=0;i<input.length;i++)input[i]=stored.optDouble(i,0);double[] normalized=PlaybackEqualizer.normalized(input);boolean[] ready={false};
        for(int i=0;i<gains.length;i++){
            final int index=i;gains[i]=normalized[i];LinearLayout column=new LinearLayout(context);column.setOrientation(LinearLayout.VERTICAL);column.setGravity(android.view.Gravity.CENTER);row.addView(column,new LinearLayout.LayoutParams((int)(52*density),LinearLayout.LayoutParams.WRAP_CONTENT));TextView value=new TextView(context);value.setGravity(android.view.Gravity.CENTER);value.setTextSize(10);column.addView(value,new LinearLayout.LayoutParams(-1,(int)(28*density)));
            VerticalEqSlider slider=new VerticalEqSlider(context);sliders[i]=slider;slider.setTag("eq-band-"+i);slider.setMax(48);slider.setProgress((int)Math.round((gains[i]+12)*2));slider.setContentDescription(PlaybackEqualizer.FREQUENCIES[i]+" Hz");column.addView(slider,new LinearLayout.LayoutParams((int)(48*density),(int)(180*density)));TextView label=new TextView(context);label.setGravity(android.view.Gravity.CENTER);label.setTextSize(11);int f=PlaybackEqualizer.FREQUENCIES[i];label.setText((f>=1000?f/1000d+"k":String.valueOf(f))+"\nHz");column.addView(label,new LinearLayout.LayoutParams(-1,(int)(40*density)));value.setText(gainText(gains[i]));
            slider.adjusted=()->{preset.setSelection(0);apply();};slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){}public void onStopTrackingTouch(SeekBar b){}public void onProgressChanged(SeekBar b,int progress,boolean user){gains[index]=progress/2d-12;value.setText(gainText(gains[index]));if(user){preset.setSelection(0);apply();}}});
        }
        TextView help=new TextView(context);help.setPadding(0,pad/2,0,pad/2);help.setText("動画・音楽で共通。この端末に保存します。大きな音のピークを保護します。");body.addView(help);note=new TextView(context);note.setTag("eq-status");body.addView(note);
        enabled.setOnCheckedChangeListener((v,value)->apply());preset.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> a){}public void onItemSelected(AdapterView<?> a,View v,int position,long id){if(!ready[0]||position==0)return;for(int i=0;i<gains.length;i++)sliders[i].setProgress((int)((PlaybackEqualizer.PRESETS[position-1][i]+12)*2));apply();}});preset.post(()->ready[0]=true);status(state);
    }
    private static String gainText(double value){return (value>0?"+":"")+value+" dB";}
    private void apply(){status(changed.apply(enabled.isChecked(),gains.clone()));}
    void status(JSONObject state){if(state==null)return;String message=state.optString("notice");note.setText(!message.isEmpty()?message:!state.optBoolean("enabled")?"イコライザーはオフです。":state.optBoolean("available")?"イコライザーを適用中":"再生開始後に適用します。");}
}
