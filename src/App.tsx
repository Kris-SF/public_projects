import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Info } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

/**
 * Retirement Monte Carlo Calculator (Inflation-adjusted, simple taxes)
 * ---------------------------------------------------------------
 * Assumptions
 * - All outputs in REAL (today's) dollars. We convert nominal returns to real by (1+nom) / (1+infl) - 1
 * - Simple flat effective tax rates: one for accumulation (on gains realized annually) and one for withdrawals
 *   (This is a simplification. Real-world taxes differ by account type.)
 * - Monte Carlo with IID annual returns drawn from Normal(mu_real, sigma). GBM-like compounding yearly.
 * - Annual contribution grows at contrib_growth (nominal). We convert to real by dividing by (1+infl)^t.
 * - Retirement spending is entered in today's dollars; we keep it constant in REAL terms (inflation-indexed spending).
 */

// ---------- Types ----------

type Inputs = {
  // Timing
  currentAge: number;
  retireAge: number;
  lifeExpectancy: number; // age at which horizon ends

  // Balances & cashflows
  currentBalance: number; // today's dollars
  annualContribution: number; // nominal amount in year 1
  contribGrowth: number; // % per year (nominal)

  // Market expectations (nominal)
  workReturnMean: number; // % arithmetic avg nominal during accumulation
  workReturnVol: number; // % stdev
  retireReturnMean: number; // % nominal during drawdown
  retireReturnVol: number; // % stdev
  inflation: number; // % CPI

  // Spending & income (today's $)
  retirementSpending: number; // real, per year
  otherIncome: number; // real, per year in retirement (e.g., Social Security)

  // Taxes (simple effective rates)
  taxAccumulation: number; // % applied to annual gains while working (effective)
  taxWithdrawal: number; // % applied to withdrawals during retirement (effective)

  // Sim
  nPaths: number;
  seed: number;
  guardrails: boolean; // dynamic withdrawal tweak
  legacyTarget: number; // optional real terminal target
};

// ---------- Utilities ----------

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function realFromNominal(muNom: number, infl: number) {
  return (1 + muNom) / (1 + infl) - 1;
}

function rng(seed: number) {
  // Mulberry32 PRNG
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(prng: () => number) {
  // Box–Muller
  const u = 1 - prng();
  const v = 1 - prng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function fmtUSD(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function percent(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

// ---------- Core Simulation ----------

function simulate(inputs: Inputs) {
  const yearsToRetire = Math.max(0, inputs.retireAge - inputs.currentAge);
  const yearsRetired = Math.max(0, inputs.lifeExpectancy - inputs.retireAge);
  const horizon = yearsToRetire + yearsRetired;

  const muWorkReal = realFromNominal(inputs.workReturnMean, inputs.inflation);
  const muRetReal = realFromNominal(inputs.retireReturnMean, inputs.inflation);

  const paths: number[][] = [];
  const depletionYear: (number | null)[] = [];

  const prng = rng(inputs.seed || 12345);

  for (let p = 0; p < inputs.nPaths; p++) {
    let bal = inputs.currentBalance; // real dollars
    const yearly: number[] = [bal];
    let died = null as number | null;

    // Accumulation phase
    for (let y = 0; y < yearsToRetire; y++) {
      // Real return draw
      const r = muWorkReal + inputs.workReturnVol * randn(prng);

      // Nominal contribution grown, then deflate to real at year y
      const nomContrib = inputs.annualContribution * Math.pow(1 + inputs.contribGrowth, y);
      const realContrib = nomContrib / Math.pow(1 + inputs.inflation, y + 1); // end-of-year contribution in real

      // Apply contribution at end of year
      // Simple effective tax on gains during accumulation
      const preTaxGain = bal * r;
      const afterTaxGain = preTaxGain * (1 - inputs.taxAccumulation);
      bal = bal + afterTaxGain + realContrib;

      yearly.push(Math.max(0, bal));
    }

    // Drawdown phase
    for (let y = 0; y < yearsRetired; y++) {
      const r = muRetReal + inputs.retireReturnVol * randn(prng);

      // Desired net spending after tax in REAL terms
      let spendReal = inputs.retirementSpending - inputs.otherIncome;
      spendReal = Math.max(0, spendReal);

      // Optional guardrails: if portfolio is stressed, reduce spending by 10%
      if (inputs.guardrails) {
        const safeMultiple = 22; // 4.5% rule flavor
        const safeLevel = (bal / safeMultiple);
        if (bal > 0 && spendReal > safeLevel * 0.06) {
          spendReal *= 0.9; // trim 10%
        }
      }

      // Gross withdrawal required to net spend after tax
      const grossWithdrawal = spendReal / (1 - inputs.taxWithdrawal);

      // Returns then withdrawal (end-of-year spending pattern)
      const gain = bal * r;
      bal = bal + gain - grossWithdrawal;
      if (bal <= 0 && died === null) {
        died = yearsToRetire + y + 1; // year index starting at 1
        bal = 0;
      }
      yearly.push(Math.max(0, bal));
    }

    paths.push(yearly);
    depletionYear.push(died);
  }

  // Aggregate stats per year (median and bands)
  const perYear = Array.from({ length: horizon + 1 }, (_, t) => {
    const values = paths.map((p) => p[t] ?? 0).sort((a, b) => a - b);
    const q = (k: number) => values[Math.floor(clamp(k * (values.length - 1), 0, values.length - 1))];
    return {
      year: t,
      p5: q(0.05),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p95: q(0.95),
    };
  });

  const successCount = paths.filter((p) => p[p.length - 1] > 0).length;
  const successRate = successCount / inputs.nPaths;

  const breachLegacy = inputs.legacyTarget > 0
    ? paths.filter((p) => p[p.length - 1] >= inputs.legacyTarget).length / inputs.nPaths
    : null;

  return { perYear, successRate, breachLegacy, depletionYear, horizon, yearsToRetire, yearsRetired };
}

// ---------- Component ----------

export default function App() {
  const [inputs, setInputs] = useState<Inputs>({
    currentAge: 46,
    retireAge: 60,
    lifeExpectancy: 95,

    currentBalance: 1000000,
    annualContribution: 60000,
    contribGrowth: 0.03,

    workReturnMean: 0.07,
    workReturnVol: 0.16,
    retireReturnMean: 0.05,
    retireReturnVol: 0.12,
    inflation: 0.025,

    retirementSpending: 180000,
    otherIncome: 40000,

    taxAccumulation: 0.1,
    taxWithdrawal: 0.15,

    nPaths: 2000,
    seed: 42,
    guardrails: true,
    legacyTarget: 0,
  });

  const { perYear, successRate, breachLegacy, yearsToRetire, yearsRetired } = useMemo(
    () => simulate(inputs),
    [inputs]
  );

  const rows = useMemo(
    () =>
      perYear.map((r) => ({
        year: r.year,
        label:
          r.year === 0
            ? `Age ${inputs.currentAge}`
            : r.year <= yearsToRetire
            ? `Age ${inputs.currentAge + r.year}`
            : `Age ${inputs.retireAge + (r.year - yearsToRetire)}`,
        p5: r.p5,
        p25: r.p25,
        p50: r.p50,
        p75: r.p75,
        p95: r.p95,
      })),
    [perYear, yearsToRetire, inputs]
  );

  function set<K extends keyof Inputs>(k: K, v: Inputs[K]) {
    setInputs((prev) => ({ ...prev, [k]: v }));
  }

  function numberField(
    k: keyof Inputs,
    label: string,
    step = 1,
    opts?: { percent?: boolean; min?: number; max?: number }
  ) {
    const isPct = opts?.percent;
    const min = opts?.min ?? (isPct ? 0 : undefined);
    const max = opts?.max ?? undefined;
    const val = inputs[k] as number;
    const shown = isPct ? (val * 100).toString() : val.toString();
    return (
      <div className="space-y-1">
        <Label className="flex items-center gap-1">
          {label}
        </Label>
        <Input
          type="number"
          step={step}
          min={min as any}
          max={max as any}
          value={shown}
          onChange={(e) => {
            const raw = parseFloat(e.target.value || "0");
            set(k as any, isPct ? raw / 100 : raw);
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-background grid grid-cols-12 gap-4 p-4">
      <div className="col-span-4 overflow-auto">
        <Card>
          <CardHeader className="pb-2 bg-primary/10 rounded-t-lg">
            <CardTitle className="text-lg font-space-grotesk">Assumptions</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Real‑dollar outputs</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {numberField("currentAge", "Current age", 1)}
              {numberField("retireAge", "Retirement age", 1)}
              {numberField("lifeExpectancy", "Life expectancy", 1)}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("currentBalance", "Current balance", 1000)}
              {numberField("annualContribution", "Annual contribution (year 1, nominal)", 1000)}
              {numberField("contribGrowth", "Contribution growth (nom)", 0.1, { percent: true })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("workReturnMean", "Accumulation return (nom)", 0.1, { percent: true })}
              {numberField("workReturnVol", "Accumulation vol", 0.1, { percent: true })}
              {numberField("retireReturnMean", "Retirement return (nom)", 0.1, { percent: true })}
              {numberField("retireReturnVol", "Retirement vol", 0.1, { percent: true })}
              {numberField("inflation", "Inflation", 0.1, { percent: true })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("retirementSpending", "Spending need (real/yr)", 1000)}
              {numberField("otherIncome", "Other income (real/yr)", 1000)}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("taxAccumulation", "Eff. tax on gains (work)", 0.1, { percent: true })}
              {numberField("taxWithdrawal", "Eff. tax on withdrawals", 0.1, { percent: true })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("nPaths", "Simulations", 1)}
              {numberField("seed", "Random seed", 1)}
            </div>

            <div className="flex items-center justify-between border border-primary/20 rounded-lg p-3 bg-primary/5">
              <div>
                <Label className="font-medium font-space-grotesk">Guardrails</Label>
                <div className="text-xs text-muted-foreground">Reduce spending 10% in stress years</div>
              </div>
              <Switch checked={inputs.guardrails} onCheckedChange={(v) => set("guardrails", v)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numberField("legacyTarget", "Legacy target at end (real)", 1000)}
              <div className="text-xs text-slate-500 self-end">Leave 0 to ignore</div>
            </div>

            <div className="text-xs text-muted-foreground flex items-start gap-2 p-3 bg-primary/5 rounded-lg border border-primary/10">
              <Info className="h-4 w-4 mt-0.5 text-primary" />
              <span>Outputs use real (inflation‑adjusted) dollars. Returns entered as nominal are converted to real using your inflation input.</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-8 overflow-auto">
        <Card className="mb-4 border-primary/20">
          <CardHeader className="pb-0 bg-primary/5">
            <CardTitle className="text-lg font-space-grotesk">Results</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 pt-2">
            <Stat label="Success probability" value={percent(successRate)} />
            {inputs.legacyTarget > 0 && (
              <Stat label= {`P(legacy ≥ ${fmtUSD(inputs.legacyTarget)})`} value={percent((simulate(inputs).breachLegacy ?? 0))} />
            )}
            <Stat label="Years to retirement" value={`${yearsToRetire}`} />
            <Stat label="Years retired" value={`${yearsRetired}`} />
            <Stat label="Horizon (yrs)" value={`${yearsToRetire + yearsRetired}`} />
          </CardContent>
        </Card>

        <Card className="border-primary/20">
          <CardHeader className="pb-2 bg-primary/5">
            <CardTitle className="text-lg font-space-grotesk">Portfolio Value (real $)</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Median & confidence bands</p>
          </CardHeader>
          <CardContent className="h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cyan-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00C4E7" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#00C4E7" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#CFCFCF" opacity={0.3} />
                <XAxis dataKey="label" interval={Math.max(0, Math.floor(rows.length / 8))} stroke="#182B40" style={{ fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <YAxis tickFormatter={(v) => (v / 1000).toFixed(0) + "k"} stroke="#182B40" style={{ fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <Tooltip formatter={(v: any) => fmtUSD(v)} contentStyle={{ backgroundColor: '#F6F4EE', border: '1px solid #CFCFCF', borderRadius: '8px', fontFamily: 'Inter' }} />
                <Area type="monotone" dataKey="p75" stroke="#CFCFCF" strokeWidth={1.5} fillOpacity={0} />
                <Area type="monotone" dataKey="p50" stroke="#00C4E7" strokeWidth={2.5} fill="url(#cyan-gradient)" />
                <Area type="monotone" dataKey="p25" stroke="#CFCFCF" strokeWidth={1.5} fillOpacity={0} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 rounded-lg border border-primary/20 bg-card hover:border-primary/40 transition-colors">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-jetbrains">{label}</div>
      <div className="text-2xl font-semibold text-primary font-space-grotesk mt-1">{value}</div>
    </div>
  );
}
