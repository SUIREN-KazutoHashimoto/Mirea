// A collection is the app's root; a series is a child, never a history filter.
export function libraryBackAction({drawer=false,modal=false,viewer=false,series=false,collection=false,canGoBack=false}={}){
  return drawer?'drawer-close':modal?'modal-close':viewer?'viewer-return':series?'series-parent':collection?'drawer-open':canGoBack?'history':'minimize';
}
