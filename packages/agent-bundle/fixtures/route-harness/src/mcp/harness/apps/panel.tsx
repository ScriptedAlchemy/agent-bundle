// A browser App surface. The route-unit level refuses to render it by name;
// nothing in the Node test bundle ever imports this module, and the guard
// keeps its observable marker inert anywhere without a browser document.
export const config = { resourceUri: 'ui://harness/panel' };

if (typeof document !== 'undefined') {
  const marker = document.createElement('span');
  marker.textContent = 'route-harness panel';
  document.body.append(marker);
}

export default function Panel() {
  return null;
}
