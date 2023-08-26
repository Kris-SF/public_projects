# -*- coding: utf-8 -*-
"""
Created on Fri Aug 25 21:10:30 2023

@author: kpa32
"""

import random
import time

def get_random_value(min_val, max_val, decimals=0):
    return round(random.uniform(min_val, max_val), decimals)

def play_game():
    options = ['spot', 'strike', 'carry', 'call', 'put']
    missing_variable = random.choice(options)
    
    spot = get_random_value(10, 110, 2)
    strike = get_random_value(.9*spot, 1.1 * spot, 0)
    carry = get_random_value(-0.05 * spot, 0.05 * spot, 2)
    
    if spot > strike:
        put = get_random_value(0, .1 * strike, 2)
    elif spot < strike:   
        put = round(get_random_value(0, .1 * strike, 2) + (strike - spot), 2)
    
    call = max(0, round(spot-strike + put + carry, 2))

    # Printing values without showing the missing variable
    if missing_variable != 'spot':
        print(f"Spot: {spot}")
    if missing_variable != 'strike':
        print(f"Strike: {strike}")
    if missing_variable != 'carry':
        print(f"Carry: {carry}")
    if missing_variable != 'call':
        print(f"Call: {call}")
    if missing_variable != 'put':
        print(f"Put: {put}")

    start_time = time.time()
    total_attempts = 0

    while True:
        user_input = float(input(f"\nEnter the value for {missing_variable}: "))
        total_attempts += 1
        
        if (missing_variable == 'spot' and user_input == spot) or \
           (missing_variable == 'strike' and int(user_input) == strike) or \
           (missing_variable == 'carry' and user_input == carry) or \
           (missing_variable == 'call' and user_input == call) or \
           (missing_variable == 'put' and user_input == put):
            print("Correct!")
            return 1, total_attempts, time.time() - start_time
        else:
            print("Incorrect! Try again.")

def main():
    num_times = int(input("How many times do you want to play? "))
    correct_count = 0
    total_attempts = 0
    total_time = 0

    for _ in range(num_times):
        correct, attempts, duration = play_game()
        correct_count += correct
        total_attempts += attempts
        total_time += duration

    accuracy = (correct_count / total_attempts) * 100
    average_time = total_time / num_times

    print(f"\nYour accuracy: {accuracy:.2f}%")
    print(f"Average time per question: {average_time:.2f} seconds")

main()


