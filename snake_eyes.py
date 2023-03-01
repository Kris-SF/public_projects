# -*- coding: utf-8 -*-
"""
Created on Tue Feb 28 18:00:01 2023

@author: kpa32
"""
import numpy as np 
import matplotlib.pyplot as plt
import pandas as pd 
import random as random

'define functions'

def roll_two_dice():

    x= random.randint(1,6) + random.randint(1,6) 
    return x

def a_single_play():
    trials = []
    tally = 0
    dice = 0
    num_of_trials = 0
    avg_roll = 0

    while dice !=2:
        dice = roll_two_dice()
        trials.append(dice)
        num_of_trials = len(trials)
    
        if dice > 2:
            tally = tally + dice 
            avg_roll = tally/num_of_trials
            
        else:
            return tally, num_of_trials, avg_roll

'simulation'

list_of_tallies = []
list_of_trial_quantities= []
list_of_avg_rolls = []



for i in range(10000):
    z = a_single_play()
    list_of_tallies.append(z[0])
    list_of_trial_quantities.append(z[1])
    list_of_avg_rolls.append(z[2])

'output arrays used to be examined in Excel'


array_tallies = np.array(list_of_tallies)
array_trial_quantities = np.array(list_of_trial_quantities)
plt.hist(array_trial_quantities, bins = np.arange(200), cumulative = (True))
'plt.hist(array_tallies, bins = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])'
plt.show()

