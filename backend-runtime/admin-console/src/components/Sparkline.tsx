import { Area, AreaChart, ResponsiveContainer } from 'recharts';

interface SparklineProps<T extends Record<string, unknown>> {
  data: T[];
  dataKey: keyof T;
  color?: string;
  fillOpacity?: number;
}

export function Sparkline<T extends Record<string, unknown>>({ data, dataKey, color = '#38bdf8', fillOpacity = 0.2 }: SparklineProps<T>) {
  if (!data.length) {
    return null;
  }

  return (
    <div style={{ width: '100%', height: 60 }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 10, bottom: 0, left: 0, right: 0 }}>
          <Area type="monotone" dataKey={dataKey as string} stroke={color} fill={color} fillOpacity={fillOpacity} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
