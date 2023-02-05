# -*- coding: utf-8 -*-


import numpy as np
import matplotlib.pyplot as plt
import pandas as pd

""""
Choose Parameters
"""
mean_return = .12
vol = .198
num_of_years = 97
initial_bankroll = 100
num_of_sims = 10000

"""
Run simulation
"""


"Selects a random return stream from a normal dist with above parameters"
return_stream = np.random.normal(mean_return, vol, num_of_years)

"Applies compounding"

sim_wealth = initial_bankroll * (1+return_stream).cumprod()

"Run for the desired number of simulations"

terminal_wealth = []
for i in range(num_of_sims):
    return_stream = np.random.normal(mean_return, vol, num_of_years)
    sim_wealth = initial_bankroll * (1+return_stream).cumprod()
    terminal_wealth.append(sim_wealth[-1])
    plt.plot(sim_wealth)
    
"""
COMPUTATIONS
"""

"Theoretical"
median_return = mean_return - .5*vol**2 
theo_median = 100*(1+median_return)**num_of_years
theo_mean = 100*(1+mean_return)**num_of_years
theo_st_dev_wealth = vol * num_of_years**.5

"Sample"
mean = np.mean(terminal_wealth)
median= np.median(terminal_wealth)
sample_st_dev_wealth = np.std(terminal_wealth)

"Converts terminal wealth from a list to a dataframe"
wealth_results = pd.DataFrame(terminal_wealth, columns= ['wealth'])
copy_wealth_results_for_excel = wealth_results.to_string(index = False)

"""
Prints outputs
"""

print("annual theo mean return = "+ str(mean_return), ", annual theo median return = " + str(median_return))
print ("mean = " + str(mean), "theo mean = "+ str(theo_mean))
print("median = "+ str(median), "theo median = "+ str(theo_median))
print( "theo st dev wealth = " + str(theo_st_dev_wealth * theo_mean), "sample st dev wealth = " + str(sample_st_dev_wealth))
