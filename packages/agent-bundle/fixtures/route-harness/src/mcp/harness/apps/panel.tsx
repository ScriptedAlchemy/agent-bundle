// A browser App surface. The route-unit level refuses to render it by name;
// nothing in the Node test bundle ever imports this module.
export const config = { resourceUri: 'ui://harness/panel' };

export default function Panel() {
  return null;
}
