/*
 * Player badge validation and SVG rendering (port of backend `api/badge.js`).
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { Badge, CustomBadgePaths } from '@openscreeps/game';
import { isRecord } from './guards.ts';

type Flip = 'rotate45' | 'rotate90' | 'rotate180';

interface BadgeShape {
  calc(param: number): [path1: string, path2: string];
  flip?: Flip;
}

const PI = Math.PI;
const cos = Math.cos;
const sin = Math.sin;

/** Tag for badge path templates: only numbers interpolate, formatted as upstream (`String`). */
function svgPath(strings: TemplateStringsArray, ...values: readonly number[]): string {
  let path = strings[0] ?? '';
  for (const [index, value] of values.entries()) path += String(value) + (strings[index + 1] ?? '');
  return path;
}

const BADGE_PATHS: Record<number, BadgeShape> = {
  1: {
    calc(param) {
      let vert = 0;
      let hor = 0;
      if (param > 0) vert = (param * 30) / 100;
      if (param < 0) hor = (-param * 30) / 100;
      return [
        svgPath`M 50 ${100 - vert} L ${hor} 50 H ${100 - hor} Z`,
        svgPath`M ${hor} 50 H ${100 - hor} L 50 ${vert} Z`,
      ];
    },
  },
  2: {
    calc(param) {
      let x = 0;
      let y = 0;
      if (param > 0) x = (param * 30) / 100;
      if (param < 0) y = (-param * 30) / 100;
      return [
        svgPath`M ${x} ${y} L 50 50 L ${100 - x} ${y} V -1 H -1 Z`,
        svgPath`M ${x} ${100 - y} L 50 50 L ${100 - x} ${100 - y} V 101 H -1 Z`,
      ];
    },
  },
  3: {
    calc(param) {
      const angle = PI / 4 + ((PI / 4) * (param + 100)) / 200;
      const angle1 = -PI / 2;
      const angle2 = PI / 2 + PI / 3;
      const angle3 = PI / 2 - PI / 3;
      return [
        svgPath`M 50 50 L ${50 + 100 * cos(angle1 - angle / 2)} ${50 + 100 * sin(angle1 - angle / 2)} L ${50 + 100 * cos(angle1 + angle / 2)} ${50 + 100 * sin(angle1 + angle / 2)} Z`,
        svgPath`M 50 50 L ${50 + 100 * cos(angle2 - angle / 2)} ${50 + 100 * sin(angle2 - angle / 2)} L ${50 + 100 * cos(angle2 + angle / 2)} ${50 + 100 * sin(angle2 + angle / 2)} Z
                          M 50 50 L ${50 + 100 * cos(angle3 - angle / 2)} ${50 + 100 * sin(angle3 - angle / 2)} L ${50 + 100 * cos(angle3 + angle / 2)} ${50 + 100 * sin(angle3 + angle / 2)}`,
      ];
    },
    flip: 'rotate180',
  },
  4: {
    calc(param) {
      param += 100;
      const y1 = 50 - (param * 30) / 200;
      const y2 = 50 + (param * 30) / 200;
      return [
        svgPath`M 0 ${y2} H 100 V 100 H 0 Z`,
        param > 0 ? svgPath`M 0 ${y1} H 100 V ${y2} H 0 Z` : '',
      ];
    },
    flip: 'rotate90',
  },
  5: {
    calc(param) {
      param += 100;
      const x1 = 50 - (param * 10) / 200 - 10;
      const x2 = 50 + (param * 10) / 200 + 10;
      return [svgPath`M ${x1} 0 H ${x2} V 100 H ${x1} Z`, svgPath`M 0 ${x1} H 100 V ${x2} H 0 Z`];
    },
    flip: 'rotate45',
  },
  6: {
    calc(param) {
      const width = 5 + ((param + 100) * 8) / 200;
      const x1 = 50;
      const x2 = 20;
      const x3 = 80;
      return [
        svgPath`M ${x1 - width} 0 H ${x1 + width} V 100 H ${x1 - width}`,
        svgPath`M ${x2 - width} 0 H ${x2 + width} V 100 H ${x2 - width} Z
                          M ${x3 - width} 0 H ${x3 + width} V 100 H ${x3 - width} Z`,
      ];
    },
    flip: 'rotate90',
  },
  7: {
    calc(param) {
      const w = 20 + (param * 10) / 100;
      return [
        `M 0 50 Q 25 30 50 50 T 100 50 V 100 H 0 Z`,
        svgPath`M 0 ${50 - w} Q 25 ${30 - w} 50 ${50 - w} T 100 ${50 - w}
                            V ${50 + w} Q 75 ${70 + w} 50 ${50 + w} T 0 ${50 + w} Z`,
      ];
    },
    flip: 'rotate90',
  },
  8: {
    calc(param) {
      const y = (param * 20) / 100;
      return [`M 0 50 H 100 V 100 H 0 Z`, svgPath`M 0 50 Q 50 ${y} 100 50 Q 50 ${100 - y} 0 50 Z`];
    },
    flip: 'rotate90',
  },
  9: {
    calc(param) {
      let y1 = 0;
      let y2 = 50;
      const h = 70;
      if (param > 0) y1 += (param / 100) * 20;
      if (param < 0) y2 += (param / 100) * 30;
      return [
        svgPath`M 50 ${y1} L 100 ${y1 + h} V 101 H 0 V ${y1 + h} Z`,
        svgPath`M 50 ${y1 + y2} L 100 ${y1 + y2 + h} V 101 H 0 V ${y1 + y2 + h} Z`,
      ];
    },
    flip: 'rotate180',
  },
  10: {
    calc(param) {
      let r = 30;
      let d = 7;
      if (param > 0) r += (param * 50) / 100;
      if (param < 0) d -= (param * 20) / 100;
      return [
        svgPath`M ${50 + d + r} ${50 - r} A ${r} ${r} 0 0 0 ${50 + d + r} ${50 + r} H 101 V ${50 - r} Z`,
        svgPath`M ${50 - d - r} ${50 - r} A ${r} ${r} 0 0 1 ${50 - d - r} ${50 + r} H -1 V ${50 - r} Z`,
      ];
    },
    flip: 'rotate90',
  },
  11: {
    calc(param) {
      let a1 = 30;
      let a2 = 30;
      const x = 50 - 50 * cos(PI / 4);
      const y = 50 - 50 * sin(PI / 4);
      if (param > 0) {
        a1 += (param * 25) / 100;
        a2 += (param * 25) / 100;
      }
      if (param < 0) a2 -= (param * 50) / 100;
      return [
        svgPath`M ${x} ${y} Q ${a1} 50 ${x} ${100 - y} H 0 V ${y} Z
                          M ${100 - x} ${y} Q ${100 - a1} 50 ${100 - x} ${100 - y} H 100 V ${y} Z`,
        svgPath`M ${x} ${y} Q 50 ${a2} ${100 - x} ${y} V 0 H ${x} Z
                          M ${x} ${100 - y} Q 50 ${100 - a2} ${100 - x} ${100 - y} V 100 H ${x} Z`,
      ];
    },
    flip: 'rotate90',
  },
  12: {
    calc(param) {
      let a1 = 30;
      let a2 = 35;
      if (param > 0) a1 += (param * 30) / 100;
      if (param < 0) a2 += (param * 15) / 100;
      return [
        svgPath`M 0 ${a1} H 100 V 100 H 0 Z`,
        svgPath`M 0 ${a1} H ${a2} V 100 H 0 Z
                          M 100 ${a1} H ${100 - a2} V 100 H 100 Z`,
      ];
    },
    flip: 'rotate180',
  },
  13: {
    calc(param) {
      let r = 30;
      let d = 0;
      if (param > 0) r += (param * 50) / 100;
      if (param < 0) d -= (param * 20) / 100;
      return [
        `M 0 0 H 50 V 100 H 0 Z`,
        svgPath`M ${50 - r} ${50 - d - r} A ${r} ${r} 0 0 0 ${50 + r} ${50 - r - d} V 0 H ${50 - r} Z`,
      ];
    },
    flip: 'rotate180',
  },
  14: {
    calc(param) {
      let a = PI / 4;
      const d = 0;
      a += (param * PI) / 4 / 100;
      return [
        svgPath`M 50 0 Q 50 ${50 + d} ${50 + 50 * cos(a)} ${50 + 50 * sin(a)} H 100 V 0 H 50 Z`,
        svgPath`M 50 0 Q 50 ${50 + d} ${50 - 50 * cos(a)} ${50 + 50 * sin(a)} H 0 V 0 H 50 Z`,
      ];
    },
    flip: 'rotate180',
  },
  15: {
    calc(param) {
      const w = 13 + (param * 6) / 100;
      const r1 = 80;
      const r2 = 45;
      const d = 10;
      return [
        svgPath`M ${50 - r1 - w} ${100 + d} A ${r1 + w} ${r1 + w} 0 0 1 ${50 + r1 + w} ${100 + d}
                                   H ${50 + r1 - w} A ${r1 - w} ${r1 - w} 0 1 0 ${50 - r1 + w} ${100 + d}`,
        svgPath`M ${50 - r2 - w} ${100 + d} A ${r2 + w} ${r2 + w} 0 0 1 ${50 + r2 + w} ${100 + d}
                                   H ${50 + r2 - w} A ${r2 - w} ${r2 - w} 0 1 0 ${50 - r2 + w} ${100 + d}`,
      ];
    },
    flip: 'rotate180',
  },
  16: {
    calc(param) {
      let a = (30 * PI) / 180;
      let d = 25;
      if (param > 0) a += (((30 * PI) / 180) * param) / 100;
      if (param < 0) d += (param * 25) / 100;
      const ring = (offset: number): string => {
        let path = '';
        for (let i = 0; i < 3; i++) {
          const angle1 = (i * PI * 2) / 3 + a / 2 + offset;
          const angle2 = (i * PI * 2) / 3 - a / 2 + offset;
          path += svgPath`M ${50 + 100 * cos(angle1)} ${50 + 100 * sin(angle1)}
                               L ${50 + 100 * cos(angle2)} ${50 + 100 * sin(angle2)}
                               L ${50 + d * cos(angle2)} ${50 + d * sin(angle2)}
                               A ${d} ${d} 0 0 1 ${50 + d * cos(angle1)} ${50 + d * sin(angle1)} Z`;
        }
        return path;
      };
      return [ring(-PI / 2), ring(PI / 2)];
    },
  },
  17: {
    calc(param) {
      let w = 35;
      let h = 45;
      if (param > 0) w += (param * 20) / 100;
      if (param < 0) h -= (param * 30) / 100;
      return [
        svgPath`M 50 45 L ${50 - w} ${h + 45} H ${50 + w} Z`,
        svgPath`M 50 0 L ${50 - w} ${h} H ${50 + w} Z`,
      ];
    },
  },
  18: {
    calc(param) {
      let a = (90 * PI) / 180;
      let d = 10;
      if (param > 0) a -= ((60 / 180) * PI * param) / 100;
      if (param < 0) d -= (param * 15) / 100;
      let path1 = '';
      let path2 = '';
      for (let i = 0; i < 3; i++) {
        const angle1 = ((PI * 2) / 3) * i + a / 2 - PI / 2;
        const angle2 = ((PI * 2) / 3) * i - a / 2 - PI / 2;
        const path = svgPath`M ${50 + 100 * cos(angle1)} ${50 + 100 * sin(angle1)}
                            L ${50 + 100 * cos(angle2)} ${50 + 100 * sin(angle2)}
                            L ${50 + d * cos((angle1 + angle2) / 2)} ${50 + d * sin((angle1 + angle2) / 2)} Z`;
        if (i === 0) path1 += path;
        else path2 += path;
      }
      return [path1, path2];
    },
    flip: 'rotate180',
  },
  19: {
    calc(param) {
      let w2 = 20;
      let w1 = 60;
      w1 += (param * 20) / 100;
      w2 += (param * 20) / 100;
      return [
        svgPath`M 50 -10 L ${50 - w1} 100 H ${50 + w1} Z`,
        w2 > 0 ? svgPath`M 50 0 L ${50 - w2} 100 H ${50 + w2} Z` : '',
      ];
    },
    flip: 'rotate180',
  },
  20: {
    calc(param) {
      let w = 10;
      let h = 20;
      if (param > 0) w += (param * 20) / 100;
      if (param < 0) h += (param * 40) / 100;
      return [
        svgPath`M 0 ${50 - h} H ${50 - w} V 100 H 0 Z`,
        svgPath`M ${50 + w} 0 V ${50 + h} H 100 V 0 Z`,
      ];
    },
    flip: 'rotate90',
  },
  21: {
    calc(param) {
      let w = 40;
      let h = 50;
      if (param > 0) w -= (param * 20) / 100;
      if (param < 0) h += (param * 20) / 100;
      return [
        svgPath`M 50 ${h} Q ${50 + w} 0 50 0 T 50 ${h} Z
                          M 50 ${100 - h} Q ${50 + w} 100 50 100 T 50 ${100 - h} Z`,
        svgPath`M ${h} 50 Q 0 ${50 + w} 0 50 T ${h} 50 Z
                          M ${100 - h} 50 Q 100 ${50 + w} 100 50 T ${100 - h} 50 Z`,
      ];
    },
    flip: 'rotate45',
  },
  22: {
    calc(param) {
      let w = 20;
      w += (param * 10) / 100;
      let path2 = '';
      for (let i = -4; i < 4; i++) {
        for (let j = -4; j < 4; j++) {
          const a = (i + j) % 2;
          path2 += svgPath`M ${50 - w - w * 2 * i} ${50 - w - w * 2 * (j + a)} h ${-w * 2} v ${w * 2} h ${w * 2} Z`;
        }
      }
      return [svgPath`M ${50 - w} ${50 - w} H ${50 + w} V ${50 + w} H ${50 - w} Z`, path2];
    },
    flip: 'rotate45',
  },
  23: {
    calc(param) {
      let w = 17;
      let h = 25;
      if (param > 0) w += (param * 35) / 100;
      if (param < 0) h -= (param * 23) / 100;
      let path1 = '';
      for (let i = -4; i <= 4; i++) {
        path1 += svgPath`M ${50 - w * i * 2} ${50 - h} l ${-w} ${-h} l ${-w} ${h} l ${w} ${h} Z`;
      }
      let path2 = '';
      for (let i = -4; i <= 4; i++) {
        path2 += svgPath`M ${50 - w * i * 2} ${50 + h} l ${-w} ${-h} l ${-w} ${h} l ${w} ${h} Z`;
      }
      return [path1, path2];
    },
    flip: 'rotate90',
  },
  24: {
    calc(param) {
      let w = 50;
      let h = 45;
      if (param > 0) w += (param * 60) / 100;
      if (param < 0) h += (param * 30) / 100;
      return [
        svgPath`M 0 ${h} L 50 70 L 100 ${h} V 100 H 0 Z`,
        svgPath`M 50 0 L ${50 + w} 100 H 100 V ${h} L 50 70 L 0 ${h} V 100 H ${50 - w} Z`,
      ];
    },
    flip: 'rotate180',
  },
};

function hsl2rgb(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh >= 0 && hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh >= 1 && hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh >= 2 && hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh >= 3 && hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh >= 4 && hh < 5) [r1, g1, b1] = [x, 0, c];
  else if (hh >= 5 && hh < 6) [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return hex(r1) + hex(g1) + hex(b1);
}

/** Legacy indexed badge palette (badge colors stored as numbers). */
const PALETTE: readonly string[] = (() => {
  const colors: string[] = [];
  const rows: Array<[s: number, l: number, grayL: number]> = [
    [0.6, 0.8, 0.8],
    [0.7, 0.5, 0.5],
    [0.4, 0.3, 0.3],
    [0.5, 0.1, 0.1],
  ];
  for (const [s, l, grayL] of rows) {
    colors.push('#' + hsl2rgb(0, 0, grayL));
    for (let i = 0; i < 19; i++) {
      colors.push('#' + hsl2rgb((i * 360) / 19, s, l));
    }
  }
  return colors;
})();

const COLOR = /^#[a-f0-9]{6}$/i;

export function isCustomBadgePaths(value: unknown): value is CustomBadgePaths {
  return isRecord(value) && typeof value.path1 === 'string' && typeof value.path2 === 'string';
}

function isStoredColor(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isInteger(value) && PALETTE[value] !== undefined)
  );
}

/** Narrows a persisted `users.badge` document; `undefined` when absent or malformed. */
export function readBadge(value: unknown): Badge | undefined {
  if (!isRecord(value)) return undefined;
  const { type, color1, color2, color3, param, flip } = value;
  let badgeType: Badge['type'];
  if (typeof type === 'number' && BADGE_PATHS[type] !== undefined) badgeType = type;
  else if (isCustomBadgePaths(type)) badgeType = { path1: type.path1, path2: type.path2 };
  else return undefined;
  if (
    !isStoredColor(color1) ||
    !isStoredColor(color2) ||
    !isStoredColor(color3) ||
    typeof param !== 'number' ||
    !Number.isFinite(param)
  ) {
    return undefined;
  }
  return {
    type: badgeType,
    color1,
    color2,
    color3,
    param,
    flip: flip === true,
  };
}

/**
 * Validates a badge submitted by a player (`POST /api/user/badge`). Numeric types must be one of
 * the 24 shapes; a path type must equal the player's administrator-assigned custom badge.
 */
export function parseSubmittedBadge(
  value: unknown,
  customBadge: CustomBadgePaths | undefined,
): Badge | undefined {
  if (!isRecord(value)) return undefined;
  const param = Number(value.param);
  if (Number.isNaN(param) || param < -100 || param > 100) return undefined;
  const { color1, color2, color3, type } = value;
  if (
    typeof color1 !== 'string' ||
    typeof color2 !== 'string' ||
    typeof color3 !== 'string' ||
    !COLOR.test(color1) ||
    !COLOR.test(color2) ||
    !COLOR.test(color3)
  ) {
    return undefined;
  }
  let badgeType: Badge['type'];
  if (typeof type === 'number') {
    if (!Number.isInteger(type) || type < 1 || type > 24) return undefined;
    badgeType = type;
  } else {
    if (
      !customBadge ||
      !isCustomBadgePaths(type) ||
      Object.keys(type).length !== 2 ||
      type.path1 !== customBadge.path1 ||
      type.path2 !== customBadge.path2
    ) {
      return undefined;
    }
    badgeType = { path1: customBadge.path1, path2: customBadge.path2 };
  }
  return { type: badgeType, color1, color2, color3, param, flip: Boolean(value.flip) };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function color(value: string | number): string {
  return escapeAttribute(typeof value === 'string' ? value : (PALETTE[value] ?? '#000000'));
}

export const EMPTY_BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;

export function getBadgeSvg(badge: Badge, border: boolean): string {
  let path1: string;
  let path2: string;
  let rotate = 0;
  if (typeof badge.type === 'number') {
    const shape = BADGE_PATHS[badge.type];
    if (!shape) return EMPTY_BADGE_SVG;
    [path1, path2] = shape.calc(badge.param);
    if (badge.flip) {
      rotate =
        shape.flip === 'rotate180'
          ? 180
          : shape.flip === 'rotate90'
            ? 90
            : shape.flip === 'rotate45'
              ? 45
              : 0;
    }
  } else {
    ({ path1, path2 } = badge.type);
  }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100" shape-rendering="geometricPrecision">
                            <defs>
                                <clipPath id="clip">
                                    <circle cx="50" cy="50" r="${border ? '48' : '52'}" />
                                    <!--<rect x="0" y="0" width="100" height="100"/>-->
                                </clipPath>
                            </defs>
                            <g transform="rotate(${String(rotate)} 50 50)">
                            <rect x="0" y="0" width="100" height="100" fill="${color(badge.color1)}" clip-path="url(#clip)"/>`;
  svg += `<path d="${escapeAttribute(path1)}" fill="${color(badge.color2)}" clip-path="url(#clip)"/>`;
  if (path2) {
    svg += `<path d="${escapeAttribute(path2)}" fill="${color(badge.color3)}" clip-path="url(#clip)"/>`;
  }
  if (border) {
    svg += `<circle cx="50" cy="50" r="47.5" fill="transparent" stroke="#000" stroke-width="5"></circle>`;
  }
  svg += `</g></svg>`;
  return svg;
}
