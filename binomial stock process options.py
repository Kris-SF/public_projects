# -*- coding: utf-8 -*-
"""
Created on Wed Aug  2 18:11:03 2023

@author: kpa32
""

# -*- coding: utf-8 -*-
"""


import math
import random
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd
import numpy as np
import matplotlib.ticker as mticker
import time

start_time = time.time()

def binomial_return(qty_ups, up_return, up_probability, start_price, steps):
	qty_downs = steps - qty_ups
	down_probability = 1- up_probability
	down_return = ((down_probability/up_probability)*up_return)
	paths = math.factorial(steps)/(math.factorial(qty_downs) * math.factorial(qty_ups))
	probability = (up_probability**qty_ups)*(down_probability**qty_downs)*paths
	price = start_price * ((1+up_return)**qty_ups) * ((1-down_return)**qty_downs)
	
	return price, probability

def theo_binomial_distribution(steps, up_return, up_probability, start_price):
    distribution = []
    for i in range(steps+1):
        distribution.append(binomial_return(i, up_return, up_probability, start_price, steps))
    return distribution
    



def create_tree(start_price, steps, up_probability, up_return, down_probability, down_return):
	tree = {}
	for i in range(steps+1):
		tree[i] = binomial_return(i, up_return, up_probability, start_price, steps)
	return tree

def option_value(tree, strike,callput):
    in_the_money =[]
    for i in range(len(tree)):
        if callput == "c" and tree[i][0]>strike:
             in_the_money.append(tree[i][1]*(tree[i][0]-strike))
        elif callput == "p" and tree[i][0]<strike: 
            in_the_money.append(tree[i][1]*(strike - tree[i][0]))
    return round(sum(in_the_money),3)

def option_delta(current_spot_price, up_probability, up_return, down_probability, down_return, steps_til_expiry, strike, callput, current_option_value):
    option_up_tree = create_tree(current_spot_price*(1+up_return), steps_til_expiry, up_probability, up_return, down_probability, down_return)
    option_up_value = option_value(option_up_tree, strike, callput)
    
    option_down_tree = create_tree(current_spot_price*(1-down_return), steps_til_expiry, up_probability, up_return, down_probability, down_return)
    option_down_value = option_value(option_down_tree, strike, callput)
    
    option_up_delta = ((option_up_value-current_option_value)/(current_spot_price*(1+up_return)-current_spot_price))
    option_down_delta = ((option_down_value-current_option_value)/(current_spot_price*(1-down_return)-current_spot_price))
    
    option_delta = option_up_delta*up_probability + option_down_delta*down_probability
    
    return option_delta

def option_and_delta(spot_price, strike, callput, steps, up_probability, up_return, down_probability, down_return):
    tree = create_tree(spot_price, steps, up_probability, up_return,down_probability,down_return)
    option = option_value(tree, strike, callput)
    delta = option_delta(spot_price, up_probability, up_return, down_probability, down_return, steps, strike, callput, option)
    return option, delta

def randomize_stock_price_change(share_price, up_probability, up_return, down_return):
    if random.random()<up_probability:
        share_price = share_price * (1+up_return)
    else:
        share_price = share_price * (1- down_return)
    return round(share_price,3)
    


#Inputs
num_of_simulations = 500
sets_of_sims = 2
up_probability = .5
down_probability = .5
up_return = .1
down_return = .1
callput = "c"
option_position = 1
initial_stock_price = 100
total_steps_til_expiry = 3



# Initialize tables before the loop
simulation_table = pd.DataFrame(columns = ['sim_number', 'trial', 'option_position', 'strike', 'terminal_price', 'stock_return', 'delta_hedged_P/L'])
path_table = pd.DataFrame(columns = ['sim_number', 'trial', 'current_step', 'strike', 'option_position', 'callput', 'share_price', 'cumulative_portfolio_P/L'])
sets_of_sims_table = pd.DataFrame(columns= ['sim_number', 'sim_total_P/L', 'mean_P/L', 'std_dev'])

for j in range(sets_of_sims):

    for i in range(num_of_simulations):
        
        stock_price = initial_stock_price
        strike = 110
        current_step = 0
        remaining_steps_til_expiry = total_steps_til_expiry - current_step

        tree = create_tree(stock_price, remaining_steps_til_expiry, up_probability, up_return, down_probability, down_return)
        option_price = option_value(tree, strike, callput)
        position_option_delta = option_delta(stock_price, up_probability, up_return, down_probability, down_return, remaining_steps_til_expiry, strike, callput, option_price)
        
        #Initialize portfolio
        
    
       
        position_data = {
            'current_step': current_step,
            'remaining steps_to_expiry': remaining_steps_til_expiry,
            'strike': strike,
            'type': callput,
            'option_position': option_position,
            'option_price': option_price,
            'option_delta': position_option_delta,
            'share_position':option_position*position_option_delta*-100,
            'share_price': stock_price,
         }
        
        path = {
            'sim_number': j+1,
            'trial': 1+i,
            'current_step': current_step,
            'strike': strike,
            'option_position': option_position,
            'callput': callput,
            'share_price': stock_price,
            'cumulative_portfolio_P/L': 0
        }
        
        portfolio = pd.DataFrame(position_data,index=[0])
        
        df_path = pd.DataFrame([path])
        path_table = pd.concat([path_table, df_path], ignore_index=True)
       
            
        while remaining_steps_til_expiry> 0:
        
            '''---------Simulation----------'''
                
            #Increment time and position data
          
            
        
            stock_price = randomize_stock_price_change(stock_price, up_probability, up_return, down_return)
            current_step = current_step + 1        
            remaining_steps_til_expiry = remaining_steps_til_expiry - 1
            tree = create_tree(stock_price, remaining_steps_til_expiry, up_probability, up_return, down_probability, down_return)
            option_price = option_value(tree, strike, callput)
            position_option_delta = option_delta(stock_price, up_probability, up_return, down_probability, down_return, remaining_steps_til_expiry, strike, callput, option_price)
            
            position_data = {
                'current_step': current_step,
                'remaining steps_to_expiry': remaining_steps_til_expiry,
                'strike': strike,
                'type': callput,
                'option_position': option_position,
                'option_price': option_price,
                'option_delta': position_option_delta,
                'share_position':option_position*position_option_delta*-100,
                'share_price': stock_price,
             }
            
            df_position = pd.DataFrame([position_data])
            portfolio = pd.concat([portfolio, df_position], ignore_index=True)
            
                    
            # Compute the change in share price from one step to the next
            portfolio['share_price_change'] = portfolio['share_price'].diff()
            portfolio['option_price_change'] = portfolio['option_price'].diff()
        
            # Compute the P/L for each step
            portfolio['share_P/L'] = portfolio['share_price_change'] * portfolio['share_position'].shift(1)
            portfolio['option_P/L'] = 100*portfolio['option_price_change'] * portfolio['option_position'].shift(1)
            
            # Compute the cumulative P/L over all steps
            portfolio['cumulative_share_P/L'] = portfolio['share_P/L'].cumsum()
            portfolio['cumulative_option_P/L'] = portfolio['option_P/L'].cumsum()
            portfolio['cumulative_portfolio_P/L'] = portfolio['cumulative_share_P/L'] + portfolio['cumulative_option_P/L']
            cumulative_portfolio_profit = portfolio['cumulative_portfolio_P/L'].iloc[-1]
            delta_hedged_profit = portfolio['cumulative_portfolio_P/L'].iloc[-1]
            
            #record trial path
            if current_step <= total_steps_til_expiry:
                path = {
                    'sim_number':j+1,
                    'trial': i+1,
                    'current_step': current_step,
                    'strike': strike,
                    'option_position': option_position,
                    'callput': callput,
                    'share_price': stock_price,
                    'cumulative_portfolio_P/L': round(cumulative_portfolio_profit,0)
                }
            
            df_path = pd.DataFrame([path])
            path_table = pd.concat([path_table, df_path], ignore_index=True)
            
            
            #Simulation Data Table
            
        simulation = {
            'sim_number':j+1,
            'trial': i+1,
            'option_position': option_position,
            'strike': strike,
            'terminal_price': round(stock_price,2),
            'stock_return': round((stock_price/portfolio['share_price'].iloc[0]-1),3),
            'delta_hedged_P/L': round(delta_hedged_profit,0),
        }
        
        
        df_simulation = pd.DataFrame([simulation])
        simulation_table = pd.concat([simulation_table, df_simulation], ignore_index=True)
    
       
       
    
         
    """there are only steps+1 possible terminal prices, i want to see the p/l distribution for each of them"""
    grouped = simulation_table.groupby('terminal_price')['delta_hedged_P/L']
    
    # Calculate mean and standard deviation for each group
    sim_summary = path_table[(path_table["sim_number"] == j+1)& (path_table["current_step"]==total_steps_til_expiry)]
    sim_mean_profit= sim_summary["cumulative_portfolio_P/L"].mean()
    sim_total_profit = sim_summary["cumulative_portfolio_P/L"].sum()
    sim_std_dev = sim_summary["cumulative_portfolio_P/L"].std()
    log_entry = {
        'sim_number': j + 1,  # trial number
        'mean_P/L': sim_mean_profit,
        'sim_total_P/L': sim_total_profit,
        'st_dev': sim_std_dev,
    }
    df_log_entry = pd.DataFrame([log_entry])
    sets_of_sims_table = pd.concat([sets_of_sims_table, df_log_entry], ignore_index=True)
    
    print('Simulation_number:', j+1)
    
    print("Total_profit_for_all_simulations:", round(sim_total_profit,1))
    print("Mean_profit_for_all_simulations:", round(sim_mean_profit,1))
    print("St_dev_for_all_simulations:", round(sim_std_dev,0))
    print("st_dev_scaled_to_initial_option_premium:", round(.01*round(sim_std_dev,0)/portfolio['option_price'].iloc[0],3))
    print("")

    # First Figure
    fig1, ax1 = plt.subplots(2, 1, figsize=(10, 10)) 

    # Plot 1: Histogram of Terminal Prices
    sns.histplot(simulation_table['terminal_price'], kde=True, ax=ax1[0], stat="percent")
    ax1[0].set_title('Distribution of Terminal Prices')
    ax1[0].set_xlabel('Terminal Price')
    ax1[0].set_ylabel('Percentage')
    ax1[0].yaxis.set_major_formatter(mticker.FuncFormatter(lambda y, _: '{:.0f}%'.format(y)))

    # Plot 2: Scatter plot between Terminal Prices and Delta Hedged P/L
    sns.barplot(x='terminal_price', y='delta_hedged_P/L', data=simulation_table, ax=ax1[1])
    ax1[1].set_title('Scatter plot between Terminal Prices and Delta Hedged P/L')
    ax1[1].set_xlabel('Terminal Price')
    ax1[1].set_ylabel('Delta Hedged P/L')

    plt.tight_layout()
    plt.show()




# Create a new figure and axis
fig, ax = plt.subplots(figsize=(10, 7))

# Group by sim_number and trial
grouped = path_table.groupby(['sim_number', 'trial'])

# Plot each share price path
for (sim, trial), group in grouped:
    ax.plot(group['current_step'], group['share_price'], label=f"Sim {sim} Trial {trial}")

# Customize the chart
ax.set_title('Share Price Path for Each Simulation and Trial')
ax.set_xlabel('Step')
ax.set_ylabel('Share Price')


# Display the chart
plt.tight_layout()
plt.show()


print("")
print("Summary of all simulations")
print("")
print("Sims per set:", num_of_simulations)
print("Total sets:", sets_of_sims)
print("")
print("Mean profit across all sets of sims:", round(sets_of_sims_table['mean_P/L'].mean(),1))
print("Standard Dev of profit across all sets of sims:", round(sets_of_sims_table['sim_total_P/L'].std(),1))
print("")
print("Mean_stock_return:", round(simulation_table['stock_return'].mean(),3))
print("Modal_stock_return:", round(simulation_table['stock_return'].mode(),3))

end_time = time.time()

elapsed_time = round(end_time - start_time,0)


#theoretical duistribution
distribution = theo_binomial_distribution(total_steps_til_expiry, up_return, up_probability, initial_stock_price)
distro_df = pd.DataFrame(distribution, columns=['terminal_price', 'theo_frequency'])
distro_df['theo_frequency'] = distro_df['theo_frequency'].round(4)

#actual distribution
terminal_price_proportions = simulation_table['terminal_price'].value_counts(normalize=True)
terminal_price_proportions = terminal_price_proportions.reset_index()
terminal_price_proportions.columns = ['terminal_price', 'actual_frequency']
terminal_price_proportions.sort_values(by='terminal_price', inplace=True)
terminal_price_proportions['actual_frequency'] = terminal_price_proportions['actual_frequency'].round(4)

#merging the table
decimals = 2
distro_df['terminal_price'] = distro_df['terminal_price'].round(decimals)
terminal_price_proportions['terminal_price'] = terminal_price_proportions['terminal_price'].round(decimals)

merged_df = distro_df.merge(terminal_price_proportions, on='terminal_price', how='left')
merged_df['actual-theo'] = merged_df['actual_frequency']-merged_df['theo_frequency']



print("")
print(merged_df)




print("")
print(f"The code took {elapsed_time} seconds to run.")
        





# Second Figure
fig2, ax2 = plt.subplots(2, 1, figsize=(10, 10)) 

# Plot 3: Bar chart of Actual and Theoretical Frequencies
position = list(range(len(merged_df['terminal_price'])))
width = 0.4
ax2[0].bar(position, merged_df['actual_frequency'], width=width, label='Actual Frequency', color='blue', edgecolor='gray')
ax2[0].bar([p + width for p in position], merged_df['theo_frequency'], width=width, label='Theoretical Frequency', color='black', edgecolor='gray')
ax2[0].set_xticks([p + 0.5 * width for p in position])
ax2[0].set_xticklabels(merged_df['terminal_price'].values, rotation=45, ha='right')
ax2[0].set_title('Comparison of Actual and Theoretical Frequencies for each Terminal Price')
ax2[0].set_xlabel('Terminal Price')
ax2[0].set_ylabel('Frequency')
ax2[0].legend(['Actual Frequency', 'Theoretical Frequency'], loc='upper left')
ax2[0].grid(axis='y')
ax2[0].yaxis.set_major_formatter(mticker.PercentFormatter(1.0, decimals=0))  # Format as percent with 1 decimal

# Plot 4: Difference between Actual and Theoretical Frequencies
sns.barplot(x='terminal_price', y='actual-theo', data=merged_df, ax=ax2[1], color='blue', edgecolor='black')
ax2[1].set_title('Difference between Actual and Theoretical Frequencies')
ax2[1].set_xlabel('Terminal Price')
ax2[1].set_ylabel('Actual - Theoretical (%)')
ax2[1].grid(axis='y')
ax2[1].yaxis.set_major_formatter(mticker.PercentFormatter(1.0, decimals=2))  # Format as percent with 1 decimal

plt.tight_layout()
plt.show()







  








    
        
    
        
        