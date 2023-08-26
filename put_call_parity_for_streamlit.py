# -*- coding: utf-8 -*-
"""
Created on Fri Aug 25 22:56:04 2023

@author: kpa32
"""

import streamlit as st
import random

def get_random_value(min_val, max_val, decimals=0):
    return round(random.uniform(min_val, max_val), decimals)

def display_question(missing_variable=None, correct_values=None):
    if missing_variable is None or correct_values is None:
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

        correct_values = {
            'spot': spot,
            'strike': strike,
            'carry': carry,
            'call': call,
            'put': put
        }

    st.write(f"Questions Remaining: {st.session_state.num_games - st.session_state.correct_answers}")

    if missing_variable != 'spot':
        st.write(f"Spot: {spot}")
    if missing_variable != 'strike':
        st.write(f"Strike: {strike}")
    if missing_variable != 'carry':
        st.write(f"Carry: {carry}")
    if missing_variable != 'call':
        st.write(f"Call: {call}")
    if missing_variable != 'put':
        st.write(f"Put: {put}")

    user_input = st.text_input(f"Enter the value for {missing_variable}:")

    if user_input:
        user_value = float(user_input)
        if correct_values[missing_variable] == user_value:
            st.session_state.correct_answers += 1
            st.success("Correct!")
            if st.session_state.correct_answers < st.session_state.num_games:
                display_question()
            else:
                check_game_end()
        else:
            st.error("Incorrect! Try again.")
            display_question(missing_variable, correct_values)

def check_game_end():
    st.write(f"Game Over! You reached {st.session_state.correct_answers} correct answers out of {st.session_state.num_games}.")
    restart_button = st.button("Play Again?")
    if restart_button:
        st.session_state.correct_answers = 0
        st.session_state.num_games = st.number_input("How many correct answers do you want to achieve?", min_value=1, max_value=100, value=1, step=1)
        display_question()

if __name__ == "__main__":
    st.title("Finance Game")
    
    # Initializing or resetting session state variables
    if 'correct_answers' not in st.session_state:
        st.session_state.correct_answers = 0
    if 'num_games' not in st.session_state:
        st.session_state.num_games = st.number_input("How many correct answers do you want to achieve?", min_value=1, max_value=100, value=1, step=1)
    
    if st.session_state.correct_answers < st.session_state.num_games:
        display_question()
    else:
        check_game_end()
