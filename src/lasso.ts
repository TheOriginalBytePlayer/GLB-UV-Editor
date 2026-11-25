// The outline drawn on screen while a rubber-band selection is being made (a rectangle or a free-hand lasso).

import type { Pt } from './geom2d';

export class LassoOverlay {
  private svg: SVGSVGElement;
  private poly: SVGPolygonElement;

  constructor(host: HTMLElement) {
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('class', 'lasso');
    this.poly = document.createElementNS(ns, 'polygon');
    this.svg.appendChild(this.poly);
    this.svg.style.display = 'none';
    host.appendChild(this.svg);
  }

  show(points: ReadonlyArray<Pt>): void {
    this.svg.style.display = 'block';
    this.poly.setAttribute('points', points.map((p) => `${p[0]},${p[1]}`).join(' '));
  }

  rect(x0: number, y0: number, x1: number, y1: number): void {
    this.show([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  }

  hide(): void {
    this.svg.style.display = 'none';
  }
}
