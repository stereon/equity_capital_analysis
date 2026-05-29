import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { CandlestickChart, BarChart, LineChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  DataZoomComponent,
  LegendComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { KLineData } from '@/lib/api';

echarts.use([
  CandlestickChart,
  BarChart,
  LineChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
  DataZoomComponent,
  LegendComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

const UP_COLOR = '#22c55e';
const DOWN_COLOR = '#ef4444';
const UP_BORDER = '#16a34a';
const DOWN_BORDER = '#dc2626';

function ma(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += values[j];
    out.push(+(sum / window).toFixed(2));
  }
  return out;
}

export default function KLineChart({ data }: { data: KLineData[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (!instanceRef.current) {
      instanceRef.current = echarts.init(ref.current, 'dark', { renderer: 'canvas' });
    }
    const chart = instanceRef.current;

    if (!data || data.length === 0) {
      chart.clear();
      return;
    }

    const dates = data.map((d) => d.date);
    // candlestick: [open, close, low, high]
    const klines = data.map((d) => [d.open, d.close, d.low, d.high]);
    const volumes = data.map((d) => {
      const up = d.close >= d.open;
      return { value: d.volume ?? 0, itemStyle: { color: up ? UP_COLOR : DOWN_COLOR } };
    });
    const closes = data.map((d) => d.close);
    const ma5 = ma(closes, 5);
    const ma10 = ma(closes, 10);
    const ma20 = ma(closes, 20);

    chart.setOption(
      {
        backgroundColor: 'transparent',
        animation: false,
        legend: {
          data: ['K 线', 'MA5', 'MA10', 'MA20'],
          textStyle: { color: '#a1a1aa' },
          top: 0,
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          backgroundColor: 'rgba(20, 20, 20, 0.95)',
          borderColor: '#3f3f46',
          textStyle: { color: '#fafafa', fontSize: 12 },
          formatter: (params: unknown) => {
            const arr = params as Array<{
              axisValueLabel?: string;
              seriesName?: string;
              data?: unknown;
            }>;
            if (!arr || arr.length === 0) return '';
            const lines: string[] = [`<div style="font-weight:600;margin-bottom:4px">${arr[0].axisValueLabel || ''}</div>`];
            for (const p of arr) {
              if (p.seriesName === 'K 线' && Array.isArray(p.data)) {
                const [, o, c, l, h] = p.data as number[];
                lines.push(
                  `<div style="display:grid;grid-template-columns:auto auto;gap:0 12px">
                    <span style="color:#a1a1aa">开 / 收</span><span>${o?.toFixed(2)} / ${c?.toFixed(2)}</span>
                    <span style="color:#a1a1aa">高 / 低</span><span>${h?.toFixed(2)} / ${l?.toFixed(2)}</span>
                  </div>`,
                );
              } else if (p.seriesName?.startsWith('MA') && typeof p.data === 'number') {
                lines.push(
                  `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#a1a1aa">${p.seriesName}</span><span>${p.data.toFixed(2)}</span></div>`,
                );
              } else if (p.seriesName === '成交量') {
                const v = typeof p.data === 'object' && p.data && 'value' in p.data ? (p.data as { value: number }).value : (p.data as number);
                lines.push(`<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#a1a1aa">成交量</span><span>${formatBigNum(v)}</span></div>`);
              }
            }
            return lines.join('');
          },
        },
        axisPointer: {
          link: [{ xAxisIndex: 'all' }],
          label: { backgroundColor: '#3f3f46' },
        },
        grid: [
          { left: '8%', right: '4%', top: 40, height: '60%' },
          { left: '8%', right: '4%', top: '76%', height: '16%' },
        ],
        xAxis: [
          {
            type: 'category',
            data: dates,
            boundaryGap: false,
            axisLine: { lineStyle: { color: '#3f3f46' } },
            axisLabel: { color: '#a1a1aa' },
            splitLine: { show: false },
          },
          {
            type: 'category',
            gridIndex: 1,
            data: dates,
            boundaryGap: false,
            axisLine: { lineStyle: { color: '#3f3f46' } },
            axisLabel: { show: false },
            axisTick: { show: false },
          },
        ],
        yAxis: [
          {
            scale: true,
            splitArea: { show: false },
            axisLabel: { color: '#a1a1aa' },
            splitLine: { lineStyle: { color: '#27272a' } },
          },
          {
            gridIndex: 1,
            scale: true,
            axisLabel: { show: false },
            axisLine: { show: false },
            splitLine: { show: false },
          },
        ],
        dataZoom: [
          { type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - (60 / Math.max(1, dates.length)) * 100), end: 100 },
          {
            type: 'slider',
            xAxisIndex: [0, 1],
            bottom: 8,
            height: 18,
            start: Math.max(0, 100 - (60 / Math.max(1, dates.length)) * 100),
            end: 100,
            textStyle: { color: '#a1a1aa', fontSize: 10 },
          },
        ],
        series: [
          {
            name: 'K 线',
            type: 'candlestick',
            data: klines,
            itemStyle: {
              color: UP_COLOR,
              color0: DOWN_COLOR,
              borderColor: UP_BORDER,
              borderColor0: DOWN_BORDER,
            },
          },
          {
            name: 'MA5',
            type: 'line',
            data: ma5,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: '#fbbf24', width: 1 },
          },
          {
            name: 'MA10',
            type: 'line',
            data: ma10,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: '#60a5fa', width: 1 },
          },
          {
            name: 'MA20',
            type: 'line',
            data: ma20,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: '#c084fc', width: 1 },
          },
          {
            name: '成交量',
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: volumes,
          },
        ],
      },
      true,
    );

    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [data]);

  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return <div ref={ref} className="h-[480px] w-full" />;
}

function formatBigNum(v: number | null | undefined): string {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toLocaleString();
}
