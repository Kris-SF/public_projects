# -*- coding: utf-8 -*-
"""
Spyder Editor

This is a temporary script file.
"""

import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
mean_return = .07
vol = .20
median_return = mean_return - .5*vol**2
num_of_years = 40
initial_bankroll = 100

return_stream = np.random.normal(mean_return, vol, num_of_years)

sim_wealth = initial_bankroll * (1+return_stream).cumprod()

terminal_wealth = []
for i in range(10000):
    return_stream = np.random.normal(mean_return, vol, num_of_years)
    sim_wealth = initial_bankroll * (1+return_stream).cumprod()
    terminal_wealth.append(sim_wealth[-1])
    plt.plot(sim_wealth)
    
mean = np.mean(terminal_wealth)
theo_st_dev_wealth = vol * num_of_years**.5
median= np.median(terminal_wealth)
theo_mean = 100*(1+mean_return)**num_of_years
theo_median = 100*(1+median_return)**num_of_years
sample_st_dev_wealth = np.std(terminal_wealth)
wealth_results = pd.DataFrame(terminal_wealth, columns= ['wealth'])
copy_wealth_results_for_excel = wealth_results.to_string(index = False)

print("annual theo mean return = "+ str(mean_return), ", annual theo median return = " + str(median_return))
print ("mean = " + str(mean), "theo mean = "+ str(theo_mean))
print("median = "+ str(median), "theo median = "+ str(theo_median))
print( "theo st dev wealth = " + str(theo_st_dev_wealth * theo_mean), "sample st dev wealth = " + str(sample_st_dev_wealth))
