
def print_list(whats_below, list_to_print):
    print("---------------------")
    print("")
    print('\033[1m' + f'Below are {whats_below}' + '\033[0m')
    if(list_to_print):
        print("")
        print(*list_to_print, sep="\n")
        print("")
        return input("Which of the above would you like to select? ")


def get_desired_value_dict(whats_below, dict_to_print):
    print("---------------------")
    print("")
    print('\033[1m' + f'Below are {whats_below}' + '\033[0m')
    print("")
    print(*dict_to_print.keys(), sep="\n")
    print("")
    desired_key = input("Which of the above would you like to select? ")
    return dict_to_print[desired_key]





def create_dropdown(variable_types, widgets, description, on_change):
    w = widgets.Dropdown(
    options=variable_types,
    value=variable_types[0],
    description=description,
    )
    
    
    
    return w