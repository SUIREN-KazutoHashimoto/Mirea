// Only editing forms opt in. Search fields and immediate settings are not drafts.
export function formHasChanges(form){
  return Array.from(form.elements??[]).some(field=>{
    if(!field.name||['submit','button','reset'].includes(field.type))return false;
    if(field.type==='checkbox'||field.type==='radio')return field.checked!==field.defaultChecked;
    if(field.options){const options=Array.from(field.options),defaults=options.filter(option=>option.defaultSelected);if(!defaults.length&&!field.multiple&&options.length)defaults.push(options[0]);return options.some(option=>option.selected!==defaults.includes(option));}
    return String(field.value??'')!==String(field.defaultValue??'');
  });
}
export function hasDialogChanges(node){return Boolean(node.hasUnsavedChanges?.()||Array.from(node.querySelectorAll('form[data-unsaved]')).some(formHasChanges));}
export function requestDialogClose(node,confirm=globalThis.confirm){if(hasDialogChanges(node)&&!confirm('変更内容を保存せずに閉じますか？'))return false;node.close();return true;}
