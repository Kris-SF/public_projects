# Trading Challenge Simulator

A Monte Carlo simulator for analyzing funded trader challenges, based on Rob Carver's quantitative analysis.

## Overview

This interactive web application simulates trading challenges using exact parameters from the Raen challenge:
- Profit target: 20%
- Daily loss limit: -2%
- Minimum trading days: 30
- Monthly fee: $300 (free resets)

## Features

- **Interactive Controls**: Adjust Sharpe Ratio and Volatility in real-time
- **Monte Carlo Simulation**: Run thousands of simulations to understand success probability
- **Visual Analytics**: Cost distributions and completion time charts
- **Presets**: Quick-load common scenarios (Rob's Safe, Strong Edge, Elite, High Vol)
- **Educational Documentation**: Built-in explanation of the volatility tradeoff

## Technology Stack

- **Vite** - Modern build tool and dev server
- **Vanilla JavaScript** - No framework dependencies
- **Chart.js** - Data visualizations
- **Google Fonts** - Inter & Space Mono typography

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment

Built for deployment to: `trading-sim.moontowermeta.com`

The application is completely self-contained with no backend or database requirements. All calculations run client-side in the browser.

## Credits

Based on [Rob Carver's quantitative analysis](https://qoppac.blogspot.com/2025/11/wordle-tm-and-one-simple-hack-you-need.html) of funded trader challenges.

## License

This is a simulation tool for educational purposes only.
