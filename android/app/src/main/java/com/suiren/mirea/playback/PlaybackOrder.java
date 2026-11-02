package com.suiren.mirea.playback;

import org.json.*;
import java.util.*;

/** In-memory shuffle bag/history only. Callers must validate fresh membership. */
final class PlaybackOrder {
    private String series;private boolean shuffled;private ArrayList<String> bag=new ArrayList<>(),seen=new ArrayList<>(),history=new ArrayList<>();private int index=-1;private final Random random;
    PlaybackOrder(){this(new Random());}PlaybackOrder(Random random){this.random=random;}
    static final class Plan {final JSONObject target;final PlaybackOrder order;Plan(JSONObject target,PlaybackOrder order){this.target=target;this.order=order;}}
    Plan plan(JSONArray assets,String id,String seriesId,int direction,boolean loop,boolean shuffle)throws JSONException{
        ArrayList<String> ids=new ArrayList<>();HashMap<String,JSONObject> items=new HashMap<>();for(int i=0;i<assets.length();i++){JSONObject item=assets.getJSONObject(i);if(Arrays.asList("video","audio").contains(item.optString("kind"))){String key=item.getString("id");if(!items.containsKey(key)){ids.add(key);items.put(key,item);}}}
        int current=ids.indexOf(id);if(current<0||seriesId==null)return null;
        PlaybackOrder next=new PlaybackOrder(random);next.series=seriesId;next.shuffled=shuffle;
        if(Objects.equals(series,seriesId)&&shuffled==shuffle&&index>=0&&index<history.size()&&history.get(index).equals(id)){next.bag=new ArrayList<>(bag);next.seen=new ArrayList<>(seen);next.history=new ArrayList<>(history);next.index=index;}else{next.seen.add(id);next.history.add(id);next.index=0;}
        String selected=null;
        if(!shuffle){int at=current+direction;if(loop)at=(at+ids.size())%ids.size();if(at>=0&&at<ids.size())selected=ids.get(at);}
        else{
            next.bag.retainAll(ids);next.seen.retainAll(ids);
            if(direction<0){for(int i=next.index-1;i>=0;i--)if(ids.contains(next.history.get(i))){next.index=i;selected=next.history.get(i);break;}}
            else if(next.index<next.history.size()-1){for(int i=next.index+1;i<next.history.size();i++)if(ids.contains(next.history.get(i))){next.index=i;selected=next.history.get(i);break;}}
            if(selected==null&&direction>0){ArrayList<String> additions=new ArrayList<>();for(String key:ids)if(!next.seen.contains(key)&&!next.bag.contains(key))additions.add(key);Collections.shuffle(additions,random);next.bag.addAll(additions);
                if(next.bag.isEmpty()&&loop){next.seen.clear();next.seen.add(id);for(String key:ids)if(!key.equals(id))next.bag.add(key);Collections.shuffle(next.bag,random);if(next.bag.isEmpty())next.bag.add(id);}
                if(!next.bag.isEmpty()){selected=next.bag.remove(0);next.seen.add(selected);next.history=new ArrayList<>(next.history.subList(0,next.index+1));next.history.add(selected);if(next.history.size()>2000)next.history.remove(0);next.index=next.history.size()-1;}
            }
        }
        return selected==null?null:new Plan(items.get(selected),next);
    }
}
