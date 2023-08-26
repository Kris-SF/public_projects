# -*- coding: utf-8 -*-
"""
Created on Fri Aug 25 22:56:04 2023

@author: kpa32
"""

import streamlit as st
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
    
    call = max(0, round(spot - strike + put + carry, 2))
    
    variables = {
        'spot': spot,
        'strike': strike,
        'carry': carry,
        'call': call,
        'put': put
    }

    st.write(f"Spot: {spot if missing_variable != 'spot' else '??'}")
    st.write(f"Strike: {strike if missing_variable != 'strike' else '??'}")
    st.write(f"Carry: {carry if missing_variable != 'carry' else '??'}")
    st.write(f"Call: {call if missing_variable != 'call' else '??'}")
    st.write(f"Put: {put if missing_variable != 'put' else '??'}")

    correct = False
    while not correct:
        user_input = st.text_input(f"Enter the value for {missing_variable}:")
        if user_input:  # check if input is not empty
            user_input = float(user_input)
            if user_input == variables[missing_variable]:
                st.write("Correct!")
                st.session_state.correct_answers += 1
                correct = True
            else:
                st.write("Incorrect! Try again.")

# Start of the main app
st.title("Finance Game")

# Capture user input for number of games
if 'num_games' not in st.session_state or st.button("Reset Game"):
    st.session_state.num_games = st.slider('How many times do you want to play?', min_value=1, max_value=10)
    st.session_state.correct_answers = 0

st.write(f"Questions Remaining: {st.session_state.num_games - st.session_state.correct_answers}")

if st.session_state.correct_answers < st.session_state.num_games:
    play_game()
else:
    st.write("Game over! Thanks for playing. Press 'Reset Game' to play again.")
