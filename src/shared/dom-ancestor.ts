// Self-contained for serialization into Firefox's content sandbox. Some host
// pages shim closest() to return false even when the element itself matches.
export function closestElement(element:Element|null,selector:string):Element|null {
  for(let node=element;node;node=node.parentElement){
    if(window.Element.prototype.matches.call(node,selector))return node;
  }
  return null;
}
