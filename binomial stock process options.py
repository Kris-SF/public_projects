# -*- coding: utf-8 -*-
"""
Created on Wed Aug  2 18:11:03 2023

@author: kpa32
"""

import math
import random
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd

def binomial_return(qty_ups, up_return, up_probability, start_price, steps):
	qty_downs = steps - qty_ups
	down_probability = 1- up_probability
	down_return = ((down_probability/up_probability)*up_return)
	paths = math.factorial(steps)/(math.factorial(qty_downs) * math.factorial(qty_ups))
	probability = (up_probability**qty_ups)*(down_probability**qty_downs)*paths
	price = start_price * ((1+up_return)**qty_ups) * ((1-down_return)**qty_downs)
	
	return price, probability



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
num_of_simulations = 100
sets_of_sims = 20

# Initialize tables before the loop
simulation_table = pd.DataFrame(columns = ['option_position', 'strike', 'terminal_price', 'delta_hedged_P/L'])
path_table = pd.DataFrame(columns = ['sim_number', 'trial', 'current_step', 'strike', 'option_position', 'callput', 'share_price', 'cumulative_portfolio_P/L'])
sets_of_sims_table = pd.DataFrame(columns= ['sim', 'mean_P/L'])

for j in range(sets_of_sims):

    for i in range(num_of_simulations):
        
        stock_price = 100
        up_probability = .5
        down_probability = .5
        up_return = .1
        down_return = .1
        
        current_step = 0
        total_steps_til_expiry = 50
        remaining_steps_til_expiry = total_steps_til_expiry - current_step
        
        strike = 110
        callput = "c"
        option_position = 1
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
            cumulative_portfolio_profit = portfolio['cumulative_portfolio_P/L'].iloc[current_step-1]
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
                    'cumulative_portfolio_P/L': cumulative_portfolio_profit
                }
            
            df_path = pd.DataFrame([path])
            path_table = pd.concat([path_table, df_path], ignore_index=True)
            
            
            #Simulation Data Table
            
        simulation = {
            'option_position': option_position,
            'strike': strike,
            'terminal_price': stock_price,
            'delta_hedged_P/L': delta_hedged_profit,
        }
        
        
        df_simulation = pd.DataFrame([simulation])
        simulation_table = pd.concat([simulation_table, df_simulation], ignore_index=True)
    
       
       
    
    
    
    """fig, ax = plt.subplots(2, 1, figsize=(10, 15))
    
    # Plot 1: Histogram of Terminal Prices
    sns.histplot(simulation_table['terminal_price'], kde=True, ax=ax[0])
    ax[0].set_title('Distribution of Terminal Prices')
    ax[0].set_xlabel('Terminal Price')
    ax[0].set_ylabel('Frequency')
    
    
    # Plot 2: Scatter plot between Terminal Prices and Delta Hedged P/L
    sns.scatterplot(x='terminal_price', y='delta_hedged_P/L', data=simulation_table, ax=ax[1])
    ax[1].set_title('Scatter plot between Terminal Prices and Delta Hedged P/L')
    ax[1].set_xlabel('Terminal Price')
    ax[1].set_ylabel('Delta Hedged P/L')
    
    
    #plt.show()"""
    
        
    # Compute the frequency of each unique delta_hedged_P/L value
    frequency = simulation_table['delta_hedged_P/L'].value_counts(normalize=True)
    
    
    """Compute average_profit_for_all_simulations"""
    average_profit_for_all_simulations = sum(value * frequency[value] for value in frequency.index)
    
    print("Mean_profit_for_all_simulations:", average_profit_for_all_simulations)
    
    
     
    """there are only steps+1 possible terminal prices, i want to see the p/l distribution for each of them"""
    grouped = simulation_table.groupby('terminal_price')['delta_hedged_P/L']
    
    # Calculate mean and standard deviation for each group
    statistics = grouped.agg(['mean', 'count']).reset_index()
    
    log_entry = {
        'sim': j + 1,  # trial number
        'mean_P/L': average_profit_for_all_simulations,
    }
    df_log_entry = pd.DataFrame([log_entry])
    sets_of_sims_table = pd.concat([sets_of_sims_table, df_log_entry], ignore_index=True)




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




